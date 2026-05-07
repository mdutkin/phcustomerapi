// Lab results and trends.

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
import { patients } from "./patients";

export const labFlagEnum = pgEnum("lab_flag", ["OK", "H", "L", "CRIT_H", "CRIT_L"]);

export const labResults = pgTable(
  "lab_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
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
    patientIdx: index("lab_patient_idx").on(t.patientId),
    codeIdx: index("lab_code_idx").on(t.testCode),
    collectedIdx: index("lab_collected_idx").on(t.collectedAt),
  }),
);
