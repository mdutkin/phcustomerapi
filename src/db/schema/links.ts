// Bridge tables between portal users (PG) and the PrimeRX MSSQL world.
//
// `user_patients` answers: "given a logged-in portal user, which PrimeRX
// patient records belong to them?" PrimeRX has two physical databases
// (PharmSQL = 340B, PharmSQLCONVENTIONAL = Conventional). A patient may
// exist in only one or in both, so the link is composite: (user_id,
// db_kind, patientno). Most users will have a single link.
//
// Refill intents used to live here as `refill_requests`. They now live in
// the unified `command_queue` (see ./commands) as type='refill_request',
// so the pharmacist gets ONE inbox across every request type rather than a
// queue per feature. We still never write to MSSQL — a pharmacist performs
// the change in the PrimeRX client and the CLAIMS row updates downstream.

import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  varchar,
  pgEnum,
  index,
  uniqueIndex,
  boolean,
} from "drizzle-orm/pg-core";
import { users } from "./auth";

// Which PrimeRX database the link points at. PharmSQL = 340B,
// PharmSQLCONVENTIONAL = Conventional. We mirror this enum on the API
// surface so callers don't leak DB names.
export const dbKindEnum = pgEnum("db_kind", ["340b", "conventional"]);

// How a user got linked to a patient record. Used for audit and to gate future
// re-verification.
//   self_verified_phone = self-claimed; possession of the on-file phone was
//     PROVEN via Firebase phone sign-in, then last name + DOB confirmed which
//     person on that line. This is the only self-service method.
//   self_dob_phone = LEGACY knowledge-only claim (name + DOB + phone last 4).
//     Retained so old rows stay readable; never written by new code.
//   manual_admin = staff linked it after verifying identity out-of-band.
//   imported = bulk migration.
export const claimMethodEnum = pgEnum("claim_method", [
  "self_verified_phone",
  "self_dob_phone",
  "manual_admin",
  "imported",
]);

export const userPatients = pgTable(
  "user_patients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    dbKind: dbKindEnum("db_kind").notNull(),
    // PrimeRX PATIENT.PATIENTNO is INT; carry as integer here.
    patientno: integer("patientno").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    claimMethod: claimMethodEnum("claim_method").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    // Snapshot of identifying fields used at claim time, for forensic
    // purposes. Does NOT replace MSSQL as source of truth.
    snapshotLastName: varchar("snapshot_last_name", { length: 80 }),
    snapshotDob: varchar("snapshot_dob", { length: 10 }),
    snapshotPhoneLast4: varchar("snapshot_phone_last4", { length: 4 }),
    notes: text("notes"),
  },
  (t) => ({
    // A user/db/patient triplet is unique — but the same PATIENTNO may
    // appear once in 340B and once in Conventional, hence db_kind in the
    // key.
    uniq: uniqueIndex("user_patients_uniq").on(t.userId, t.dbKind, t.patientno),
    userIdx: index("user_patients_user_idx").on(t.userId),
    // Helps pharmacy admin lookups: "who is linked to PATIENTNO 12345 in 340B?"
    patientIdx: index("user_patients_patient_idx").on(t.dbKind, t.patientno),
  }),
);

export type DbKind = (typeof dbKindEnum.enumValues)[number];
