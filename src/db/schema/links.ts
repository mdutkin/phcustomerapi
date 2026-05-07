// Bridge tables between portal users (PG) and the PrimeRX MSSQL world.
//
// `user_patients` answers: "given a logged-in portal user, which PrimeRX
// patient records belong to them?" PrimeRX has two physical databases
// (PharmSQL = 340B, PharmSQLCONVENTIONAL = Conventional). A patient may
// exist in only one or in both, so the link is composite: (user_id,
// db_kind, patientno). Most users will have a single link.
//
// `refill_requests` is the portal's queue of refill intents. We do NOT
// write to MSSQL — the pharmacy still drives fulfillment in PrimeRX. A
// refill request lands here, the pharmacy picks it up, and once filled
// the source of truth (CLAIMS row in MSSQL) updates downstream views.

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

// How a user got linked to a patient record. Used for audit and to gate
// future re-verification. `self_dob_phone` = patient self-claimed via
// DOB + last name + phone match. `manual_admin` = staff linked via admin
// UI. `imported` = bulk migration.
export const claimMethodEnum = pgEnum("claim_method", [
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

export const refillRequestStatusEnum = pgEnum("refill_request_status", [
  "queued",
  "in_review",
  "accepted",
  "rejected",
  "filled",
  "canceled",
]);

export const refillRequests = pgTable(
  "refill_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // The PrimeRX patient this refill is for. We keep these denormalised
    // (rather than FK to user_patients.id) so a single refill request
    // survives even if the link row is later changed/replaced.
    dbKind: dbKindEnum("db_kind").notNull(),
    patientno: integer("patientno").notNull(),
    // CLAIMS.RXNO is BIGINT in MSSQL — store as bigint-safe text to
    // avoid JS number truncation. Format is digits only.
    rxno: varchar("rxno", { length: 32 }).notNull(),
    // Optional: which fill cycle this is for (NREFILL on CLAIMS).
    refillNo: integer("refill_no"),
    status: refillRequestStatusEnum("status").notNull().default("queued"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: varchar("decided_by", { length: 80 }),
    decisionNote: text("decision_note"),
    // Optional patient-supplied note — "running low, please rush".
    patientNote: text("patient_note"),
  },
  (t) => ({
    userIdx: index("refill_requests_user_idx").on(t.userId),
    rxIdx: index("refill_requests_rx_idx").on(t.dbKind, t.patientno, t.rxno),
    statusIdx: index("refill_requests_status_idx").on(t.status),
  }),
);

export type DbKind = (typeof dbKindEnum.enumValues)[number];
