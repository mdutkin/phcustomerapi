// Messaging — pharmacy/doctor/support threads owned by a portal user.

import {
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
  pgEnum,
  index,
  boolean,
} from "drizzle-orm/pg-core";
import { users } from "./auth";

export const senderRoleEnum = pgEnum("sender_role", ["patient", "pharm", "doc", "support", "system"]);

export const threads = pgTable(
  "threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    counterpartName: varchar("counterpart_name", { length: 160 }).notNull(),
    counterpartRole: senderRoleEnum("counterpart_role").notNull(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("threads_user_idx").on(t.userId),
  }),
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    senderRole: senderRoleEnum("sender_role").notNull(),
    body: text("body").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    readByPatient: boolean("read_by_patient").notNull().default(false),
  },
  (t) => ({
    threadIdx: index("messages_thread_idx").on(t.threadId),
    sentIdx: index("messages_sent_idx").on(t.sentAt),
  }),
);
