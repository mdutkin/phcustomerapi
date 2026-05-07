// Patient lookups. The /me endpoint merges:
//   - portal user data (PG)
//   - the user's primary PrimeRX patient record (MSSQL)
//   - portal-side extra addresses (PG)
//
// If the user is not yet linked to a PrimeRX patient, /me still returns
// the user data — the UI then prompts for self-claim.

import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { addresses, userPatients, users } from "@/db/schema";
import { getPatient } from "@/db/mssql-models";
import type { DbKind, PrimeRxPatient } from "@/db/mssql-models";
import { HttpError } from "@/plugins/error-handler";

export interface MeResult {
  user: {
    id: string;
    email: string | null;
    phoneE164: string | null;
    createdAt: Date;
  };
  link:
    | {
        dbKind: DbKind;
        patientno: number;
        isPrimary: boolean;
      }
    | null;
  patient: PrimeRxPatient | null;
  addresses: Array<{
    id: string;
    label: string;
    line1: string;
    line2: string | null;
    city: string;
    state: string;
    postalCode: string;
    isDefault: boolean;
  }>;
}

export async function getMeForUser(userId: string): Promise<MeResult> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new HttpError(404, "user_not_found");

  // Pick the primary link, or any link if no primary flag is set.
  const links = await db
    .select()
    .from(userPatients)
    .where(eq(userPatients.userId, userId))
    .orderBy(userPatients.isPrimary);
  const primary = links.find((l) => l.isPrimary) ?? links[0] ?? null;

  let patient: PrimeRxPatient | null = null;
  if (primary) {
    patient = await getPatient(primary.dbKind, primary.patientno);
  }

  const addressRows = await db
    .select()
    .from(addresses)
    .where(eq(addresses.userId, userId));

  return {
    user: {
      id: user.id,
      email: user.email,
      phoneE164: user.phoneE164,
      createdAt: user.createdAt,
    },
    link: primary
      ? { dbKind: primary.dbKind, patientno: primary.patientno, isPrimary: primary.isPrimary }
      : null,
    patient,
    addresses: addressRows.map((a) => ({
      id: a.id,
      label: a.label,
      line1: a.line1,
      line2: a.line2,
      city: a.city,
      state: a.state,
      postalCode: a.postalCode,
      isDefault: a.isDefault,
    })),
  };
}

/**
 * Resolve the primary PrimeRX link for a user. Throws 409 if the user
 * has not yet claimed a patient record. Used by Rx, deliveries, and
 * billing endpoints that need a patient identity.
 */
export async function requirePatientLink(userId: string): Promise<{
  dbKind: DbKind;
  patientno: number;
}> {
  const links = await db
    .select()
    .from(userPatients)
    .where(eq(userPatients.userId, userId));
  const primary = links.find((l) => l.isPrimary) ?? links[0];
  if (!primary) {
    throw new HttpError(
      409,
      "patient_not_linked",
      "This account is not yet linked to a patient record. Run the self-claim flow.",
    );
  }
  return { dbKind: primary.dbKind, patientno: primary.patientno };
}

/**
 * Helper for routes that must verify the (dbKind, patientno) pair
 * belongs to the logged-in user. Throws 403 if not.
 */
export async function assertUserOwnsPatient(
  userId: string,
  dbKind: DbKind,
  patientno: number,
): Promise<void> {
  const [link] = await db
    .select({ id: userPatients.id })
    .from(userPatients)
    .where(
      and(
        eq(userPatients.userId, userId),
        eq(userPatients.dbKind, dbKind),
        eq(userPatients.patientno, patientno),
      ),
    )
    .limit(1);
  if (!link) throw new HttpError(403, "patient_link_not_owned");
}
