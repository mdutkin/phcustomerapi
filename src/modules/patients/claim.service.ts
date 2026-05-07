// Self-claim flow.
//
// The patient supplies last name + DOB + a phone number. We probe both
// PrimeRX databases (340B, Conventional) for an exact match. If a
// unique match is found in exactly one database — or in both, with the
// same patient identity — we create a `user_patients` link.
//
// Hard rules:
//   - Last name + DOB + phone-last-4 must ALL match. No two-of-three.
//   - If the search is ambiguous (multiple PATIENTNO matches in one DB),
//     refuse — pharmacy admin must resolve manually.
//   - If the user is already linked to ANY patient, refuse — they need
//     admin help to add a second link.
//   - Phone supplied at claim does not need to be the user's login
//     phone; it just has to match the on-file phone in PrimeRX.

import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { userPatients } from "@/db/schema";
import { searchPatientForClaim } from "@/db/mssql-models";
import type { DbKind, PrimeRxPatient } from "@/db/mssql-models";
import { HttpError } from "@/plugins/error-handler";

export interface ClaimInput {
  lastName: string;
  dob: string;        // YYYY-MM-DD
  phone: string;      // any format; we use last 4 digits
}

export interface ClaimResult {
  dbKind: DbKind;
  patientno: number;
  patient: PrimeRxPatient;
  alreadyLinked: boolean;
}

const DB_KINDS: DbKind[] = ["340b", "conventional"];

export async function claimPatient(userId: string, input: ClaimInput): Promise<ClaimResult> {
  // Reject if user already has any link — admin must add additional links.
  const existing = await db
    .select({ id: userPatients.id })
    .from(userPatients)
    .where(eq(userPatients.userId, userId))
    .limit(1);
  if (existing.length > 0) {
    throw new HttpError(
      409,
      "already_linked",
      "This account already has a patient link. Contact support to add another.",
    );
  }

  const phoneLast4 = input.phone.replace(/\D/g, "").slice(-4);
  if (phoneLast4.length !== 4) {
    throw new HttpError(400, "invalid_phone", "Phone must contain at least 4 digits.");
  }

  // Probe both DBs.
  const matches: Array<{ dbKind: DbKind; patient: PrimeRxPatient }> = [];
  for (const kind of DB_KINDS) {
    const hit = await searchPatientForClaim(kind, {
      lastName: input.lastName,
      dob: input.dob,
      phoneLast4,
    });
    if (hit) matches.push({ dbKind: kind, patient: hit });
  }

  if (matches.length === 0) {
    throw new HttpError(
      404,
      "patient_not_found",
      "No matching patient on file. Check the details or contact the pharmacy.",
    );
  }

  // If we hit both DBs with different PATIENTNOs, that's two different
  // identities matching the same demographics — refuse, admin must
  // disambiguate.
  if (matches.length > 1) {
    const allSame = matches.every((m) => m.patient.patientno === matches[0]!.patient.patientno);
    if (!allSame) {
      throw new HttpError(
        409,
        "ambiguous_match",
        "Multiple records match. Contact the pharmacy to verify identity.",
      );
    }
  }

  const winner = matches[0]!;

  // Guard against double-claim of the same patient by another user.
  const [taken] = await db
    .select({ id: userPatients.id })
    .from(userPatients)
    .where(
      and(
        eq(userPatients.dbKind, winner.dbKind),
        eq(userPatients.patientno, winner.patient.patientno),
      ),
    )
    .limit(1);
  if (taken) {
    throw new HttpError(
      409,
      "patient_already_claimed",
      "This patient record is linked to another account. Contact the pharmacy.",
    );
  }

  await db.insert(userPatients).values({
    userId,
    dbKind: winner.dbKind,
    patientno: winner.patient.patientno,
    isPrimary: true,
    claimMethod: "self_dob_phone",
    snapshotLastName: input.lastName.slice(0, 80),
    snapshotDob: input.dob,
    snapshotPhoneLast4: phoneLast4,
  });

  return {
    dbKind: winner.dbKind,
    patientno: winner.patient.patientno,
    patient: winner.patient,
    alreadyLinked: false,
  };
}
