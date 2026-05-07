// HIPAA-style audit log. Every PHI read/write should land here.
// Designed for append-only writes; no UPDATE/DELETE in normal operation.
//
// `subjectUserId` is the portal user the action concerned. For actions
// that touched a PrimeRX patient record (which lives in MSSQL), stash
// `{ dbKind, patientno }` in `metadata` — we deliberately don't put a
// hard FK there, since MSSQL is read-only and not in this DB.

import {
  pgTable,
  timestamp,
  uuid,
  varchar,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id"),
    actorIp: varchar("actor_ip", { length: 45 }),
    action: varchar("action", { length: 64 }).notNull(),
    resourceType: varchar("resource_type", { length: 64 }).notNull(),
    resourceId: varchar("resource_id", { length: 64 }),
    subjectUserId: uuid("subject_user_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    occurredIdx: index("audit_occurred_idx").on(t.occurredAt),
    actorIdx: index("audit_actor_idx").on(t.actorUserId),
    subjectIdx: index("audit_subject_idx").on(t.subjectUserId),
    resourceIdx: index("audit_resource_idx").on(t.resourceType, t.resourceId),
  }),
);
