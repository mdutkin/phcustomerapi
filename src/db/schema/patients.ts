// Patient-side PG tables.
//
// IMPORTANT: patient demographics, prescribers, pharmacies, insurance, drugs,
// and prescriptions are all read from the PrimeRX MSSQL databases via
// `src/db/mssql-models/*`. They are NOT mirrored here.
//
// What lives in PG instead:
//   - `users` (auth identity) — see `auth.ts`
//   - `user_patients` (link from a portal user to one or more PrimeRX
//     patients across the 340B / Conventional databases) — see `links.ts`
//   - `addresses` below — extra shipping addresses a user wants to use for
//     OTC orders. The patient's primary address still comes from MSSQL.

import {
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
  index,
  boolean,
} from "drizzle-orm/pg-core";
import { users } from "./auth";

export const addresses = pgTable(
  "addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: varchar("label", { length: 32 }).notNull(),
    line1: text("line1").notNull(),
    line2: text("line2"),
    city: varchar("city", { length: 80 }).notNull(),
    state: varchar("state", { length: 2 }).notNull(),
    postalCode: varchar("postal_code", { length: 12 }).notNull(),
    country: varchar("country", { length: 2 }).notNull().default("US"),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("addresses_user_idx").on(t.userId),
  }),
);
