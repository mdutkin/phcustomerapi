// Patient demographics + insurance + addresses + prescribers.

import {
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
  date,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./auth";

export const patients = pgTable(
  "patients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    firstName: varchar("first_name", { length: 80 }).notNull(),
    lastName: varchar("last_name", { length: 80 }).notNull(),
    dob: date("dob").notNull(),
    phoneE164: varchar("phone_e164", { length: 20 }),
    email: varchar("email", { length: 254 }),
    preferredPharmacyId: uuid("preferred_pharmacy_id"),
    primaryPrescriberId: uuid("primary_prescriber_id"),
    allergies: jsonb("allergies").$type<string[]>().notNull().default([]),
    conditions: jsonb("conditions").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("patients_user_idx").on(t.userId),
  }),
);

export const addresses = pgTable(
  "addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    label: varchar("label", { length: 32 }).notNull(),
    line1: text("line1").notNull(),
    line2: text("line2"),
    city: varchar("city", { length: 80 }).notNull(),
    state: varchar("state", { length: 2 }).notNull(),
    postalCode: varchar("postal_code", { length: 12 }).notNull(),
    country: varchar("country", { length: 2 }).notNull().default("US"),
    isDefault: text("is_default").notNull().default("false"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    patientIdx: index("addresses_patient_idx").on(t.patientId),
  }),
);

export const insurancePlans = pgTable(
  "insurance_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    plan: varchar("plan", { length: 120 }).notNull(),
    memberId: varchar("member_id", { length: 60 }).notNull(),
    groupId: varchar("group_id", { length: 60 }),
    effectiveFrom: date("effective_from"),
    effectiveTo: date("effective_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    patientIdx: index("insurance_patient_idx").on(t.patientId),
  }),
);

export const prescribers = pgTable("prescribers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 160 }).notNull(),
  specialty: varchar("specialty", { length: 80 }),
  clinic: varchar("clinic", { length: 160 }),
  phone: varchar("phone", { length: 20 }),
  npi: varchar("npi", { length: 10 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pharmacies = pgTable("pharmacies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 160 }).notNull(),
  address: text("address").notNull(),
  phone: varchar("phone", { length: 20 }),
  hours: text("hours"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
