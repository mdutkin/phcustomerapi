// Lab results — STUB until NextGen integration lands.
//
// Per Max (2026-05-07): "Labs data will be coming over API from NextGen —
// we need to stab the data for now." So we keep a simple PG table with
// the dimensions we expect to surface in the UI (value, flag, ref range,
// trend over time). Once the NextGen API is wired up, this becomes a
// read-through cache or is replaced by a live MSSQL-style read model.

import {
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
  numeric,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./auth";

export const labFlagEnum = pgEnum("lab_flag", ["OK", "H", "L", "CRIT_H", "CRIT_L"]);

export const labResults = pgTable(
  "lab_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    testCode: varchar("test_code", { length: 32 }).notNull(),
    testName: varchar("test_name", { length: 160 }).notNull(),
    category: varchar("category", { length: 80 }),
    source: varchar("source", { length: 80 }),
    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull(),
    value: numeric("value", { precision: 12, scale: 4 }).notNull(),
    unit: varchar("unit", { length: 24 }),
    flag: labFlagEnum("flag").notNull().default("OK"),
    refLow: numeric("ref_low", { precision: 12, scale: 4 }),
    refHigh: numeric("ref_high", { precision: 12, scale: 4 }),
    refRangeText: varchar("ref_range_text", { length: 64 }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("lab_user_idx").on(t.userId),
    codeIdx: index("lab_code_idx").on(t.testCode),
    collectedIdx: index("lab_collected_idx").on(t.collectedAt),
  }),
);
