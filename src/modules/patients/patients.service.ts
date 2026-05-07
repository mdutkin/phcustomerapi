// Patient lookups. The current /me endpoint returns the patient bound to the
// authenticated user; later flows will let an authenticated parent or
// guardian access dependents.

import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { addresses, insurancePlans, patients, prescribers, pharmacies } from "@/db/schema";
import { HttpError } from "@/plugins/error-handler";

export async function getPatientForUser(userId: string) {
  const [patient] = await db
    .select()
    .from(patients)
    .where(eq(patients.userId, userId))
    .limit(1);
  if (!patient) throw new HttpError(404, "patient_not_found", "No patient is linked to this account.");

  const [insurance] = patient.id
    ? await db.select().from(insurancePlans).where(eq(insurancePlans.patientId, patient.id)).limit(1)
    : [];

  const addressRows = await db
    .select()
    .from(addresses)
    .where(eq(addresses.patientId, patient.id));

  const [primaryPrescriber] = patient.primaryPrescriberId
    ? await db.select().from(prescribers).where(eq(prescribers.id, patient.primaryPrescriberId)).limit(1)
    : [];

  const [preferredPharmacy] = patient.preferredPharmacyId
    ? await db.select().from(pharmacies).where(eq(pharmacies.id, patient.preferredPharmacyId)).limit(1)
    : [];

  return { patient, insurance, addresses: addressRows, primaryPrescriber, preferredPharmacy };
}
