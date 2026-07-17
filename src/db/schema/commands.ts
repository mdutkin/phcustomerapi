// The command queue — the pharmacist's inbox.
//
// WHY THIS EXISTS
// PrimeRX has no API; its own C# client writes straight to the MSSQL DB, which
// means the business logic lives in that client, not the database. So we do NOT
// write to PrimeRX from the API. Instead, every patient-initiated change becomes
// a COMMAND row here (our Postgres). A pharmacist picks it up and performs it in
// the PrimeRX client — their app applies the correct business logic by
// construction.
//
// One row serves both sides: the patient sees it as "my request + status", the
// pharmacist sees it as "a job to do". This is deliberately ONE table so staff
// get a single inbox rather than a queue per feature.
//
// FUTURE: `executionMode` is the graduation switch. Once a command type's write
// pattern is properly reverse-engineered, it can flip to `auto` and be executed
// by a worker instead of a human — no schema change, no redesign. `attempts` /
// `lastError` exist for that day.

import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  varchar,
  jsonb,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth";
import { dbKindEnum } from "./links";

// What the pharmacist has to do. Extend as features land.
export const commandTypeEnum = pgEnum("command_type", [
  "refill_request", // queue a refill for an existing Rx
  "update_details", // change patient demographics (phone / email / address)
  "update_delivery", // change delivery address or date
]);

export const commandStatusEnum = pgEnum("command_status", [
  "pending", // waiting for a pharmacist
  "in_progress", // a pharmacist claimed it
  "done", // performed in PrimeRX
  "rejected", // pharmacist declined (reason in staffNote)
  "canceled", // patient withdrew it
  "failed", // only reachable in `auto` mode
]);

// manual = a human performs it in the PrimeRX client (today, always).
// auto    = a worker executes the write (future, per-type opt-in).
export const commandExecutionModeEnum = pgEnum("command_execution_mode", ["manual", "auto"]);

export const commandQueue = pgTable(
  "command_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    // Which PrimeRX patient this concerns. Denormalised (not an FK to
    // user_patients) so the command survives if the link row changes later —
    // it's a historical record of what was asked, for whom.
    dbKind: dbKindEnum("db_kind").notNull(),
    patientno: integer("patientno").notNull(),

    type: commandTypeEnum("type").notNull(),
    // Type-specific body, validated by a Zod schema at the API boundary before
    // it ever gets here. Keeps one table across many command shapes.
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),

    status: commandStatusEnum("status").notNull().default("pending"),
    executionMode: commandExecutionModeEnum("execution_mode").notNull().default("manual"),

    // Collapses duplicate open requests for the same thing (e.g. the same RXNO).
    // Enforced by a partial unique index over open statuses only.
    dedupeKey: varchar("dedupe_key", { length: 128 }).notNull(),

    // Optional patient-supplied context — "running low, please rush".
    patientNote: text("patient_note"),

    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),

    // Pharmacist working it.
    claimedBy: varchar("claimed_by", { length: 120 }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),

    completedBy: varchar("completed_by", { length: 120 }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // Rejection reason or free-text note from the pharmacist.
    staffNote: text("staff_note"),

    // What actually happened — e.g. before/after snapshot the pharmacist
    // confirms. Feeds the audit trail.
    result: jsonb("result").$type<Record<string, unknown>>(),

    // Only used once executionMode = 'auto'.
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
  },
  (t) => ({
    // The staff inbox query: oldest pending first.
    inboxIdx: index("command_queue_inbox_idx").on(t.status, t.requestedAt),
    userIdx: index("command_queue_user_idx").on(t.userId),
    patientIdx: index("command_queue_patient_idx").on(t.dbKind, t.patientno),
    // At most ONE open command per user+type+target.
    openUniq: uniqueIndex("command_queue_open_uniq")
      .on(t.userId, t.type, t.dedupeKey)
      .where(sql`status in ('pending', 'in_progress')`),
  }),
);

export type CommandType = (typeof commandTypeEnum.enumValues)[number];
export type CommandStatus = (typeof commandStatusEnum.enumValues)[number];

// Statuses that mean "still outstanding" — used for dedupe + patient views.
export const OPEN_COMMAND_STATUSES: CommandStatus[] = ["pending", "in_progress"];
