// HIPAA-style audit log. Every PHI read/write should land here.
// Designed for append-only writes; no UPDATE/DELETE in normal operation.

import {
  pgTable,
  text,
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
    patientId: uuid("patient_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    occurredIdx: index("audit_occurred_idx").on(t.occurredAt),
    actorIdx: index("audit_actor_idx").on(t.actorUserId),
    patientIdx: index("audit_patient_idx").on(t.patientId),
    resourceIdx: index("audit_resource_idx").on(t.resourceType, t.resourceId),
  }),
);
