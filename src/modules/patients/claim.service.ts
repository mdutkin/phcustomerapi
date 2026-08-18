// Self-claim: link a signed-in portal user to their PrimeRX patient record.
//
// THREAT MODEL: assume an attacker already holds the patient's name, DOB, SSN,
// addresses and old phone numbers (breach dumps). So knowledge can never be the
// gate — it only RESOLVES which record we mean. The gate is POSSESSION.
//
// The possession factor is the phone Firebase already verified at sign-in. If
// PrimeRX has that same number on file for the patient, the user has
// demonstrably controlled the pharmacy's on-file contact — something leaked PII
// cannot do. Last name + DOB then only disambiguate which person on that line
// it is (households share numbers).
//
// Hard rules:
//   - The phone comes from the VERIFIED token, never from the request body.
//   - A number shared by more than MAX_SHARED_PHONE active patients proves
//     nothing (legacy data has a placeholder PHONE on 3,265 records) → refuse.
//   - Ambiguous match → refuse; a human resolves it.
//   - Patient already linked to another account → refuse.
//   - Failure messages are deliberately generic (anti-enumeration).
//
// NOT YET IMPLEMENTED: the fallback for users whose sign-in number is NOT on
// file (changed phone) — that needs an OTP to the on-file number via Twilio.
// Until then those users get the staff path.

import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { userPatients } from "@/db/schema";
import { countPatientsByPhone, findClaimCandidatesByVerifiedPhone } from "@/db/mssql-models";
import type { DbKind, PrimeRxPatient } from "@/db/mssql-models";
import { HttpError } from "@/plugins/error-handler";

export interface ClaimInput {
  lastName: string;
  dob: string; // YYYY-MM-DD
}

export interface ClaimResult {
  dbKind: DbKind;
  patientno: number;
  patient: PrimeRxPatient;
  linkedDbKinds: DbKind[];
}

const DB_KINDS: DbKind[] = ["340b", "conventional"];

// Above this, a number is a shared/placeholder line and carries no identity
// signal. Recent data tops out at 2 patients per mobile (families).
const MAX_SHARED_PHONE = 3;

// One generic failure for every "couldn't verify" case, so the endpoint can't be
// used to probe who exists.
function unverified(): HttpError {
  return new HttpError(
    404,
    "not_verified",
    "We couldn't match those details to a patient on this phone number. Please call the pharmacy and we'll get you set up.",
  );
}

export async function claimPatient(
  userId: string,
  verifiedPhone: string | undefined,
  input: ClaimInput,
): Promise<ClaimResult> {
  const existing = await db
    .select({ id: userPatients.id })
    .from(userPatients)
    .where(eq(userPatients.userId, userId))
    .limit(1);
  if (existing.length > 0) {
    throw new HttpError(
      409,
      "already_linked",
      "This account is already linked to a patient. Contact the pharmacy to add another.",
    );
  }

  // No verified phone = no possession factor = no self-claim.
  const last10 = (verifiedPhone ?? "").replace(/\D/g, "").slice(-10);
  if (last10.length !== 10) {
    throw new HttpError(
      409,
      "phone_verification_required",
      "Sign in with your mobile number so we can verify you, or call the pharmacy.",
    );
  }

  // Blocklist shared/placeholder numbers before they can match anything.
  let sharedCount = 0;
  for (const kind of DB_KINDS) {
    sharedCount += await countPatientsByPhone(kind, last10);
  }
  if (sharedCount > MAX_SHARED_PHONE) throw unverified();

  // Possession (verified phone) + identity (last name + DOB), matched in SQL.
  const matches: Array<{ dbKind: DbKind; patient: PrimeRxPatient }> = [];
  for (const kind of DB_KINDS) {
    const hits = await findClaimCandidatesByVerifiedPhone(kind, last10, input.lastName, input.dob);
    for (const p of hits) matches.push({ dbKind: kind, patient: p });
  }

  if (matches.length === 0) throw unverified();

  // The same human commonly exists in BOTH databases (340B + Conventional), but
  // each DB assigns its OWN PATIENTNO — the two rows do NOT share a number. They
  // are still one identity (same verified phone + last name + DOB), so we link
  // both and the patient sees all their Rxs. Genuine ambiguity is two DIFFERENT
  // people matching WITHIN a single database.
  const byDb = new Map<DbKind, Array<{ dbKind: DbKind; patient: PrimeRxPatient }>>();
  for (const m of matches) {
    const arr = byDb.get(m.dbKind) ?? [];
    arr.push(m);
    byDb.set(m.dbKind, arr);
  }
  for (const [, hits] of byDb) {
    const distinctInDb = new Set(hits.map((h) => h.patient.patientno));
    if (distinctInDb.size > 1) {
      throw new HttpError(
        409,
        "ambiguous_match",
        "More than one record matches. Please call the pharmacy so we can verify your identity.",
      );
    }
  }

  // At most one record per database now → that's our person. Link each DB's row.
  const links = [...byDb.values()].map((hits) => hits[0]!);

  // Don't let a second account claim a record someone already holds. PATIENTNO is
  // only unique WITHIN a database, so match on (dbKind, patientno) together.
  for (const l of links) {
    const [taken] = await db
      .select({ id: userPatients.id })
      .from(userPatients)
      .where(
        and(eq(userPatients.dbKind, l.dbKind), eq(userPatients.patientno, l.patient.patientno)),
      )
      .limit(1);
    if (taken) {
      throw new HttpError(
        409,
        "patient_already_claimed",
        "That patient record is already linked to an account. Please call the pharmacy.",
      );
    }
  }

  await db.insert(userPatients).values(
    links.map((l, i) => ({
      userId,
      dbKind: l.dbKind,
      patientno: l.patient.patientno,
      isPrimary: i === 0,
      claimMethod: "self_verified_phone" as const,
      snapshotLastName: input.lastName.slice(0, 80),
      snapshotDob: input.dob,
      snapshotPhoneLast4: last10.slice(-4),
    })),
  );

  return {
    dbKind: links[0]!.dbKind,
    patientno: links[0]!.patient.patientno,
    patient: links[0]!.patient,
    linkedDbKinds: links.map((l) => l.dbKind),
  };
}
