// Prescriptions, refills, and drug references.

import {
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
  integer,
  numeric,
  date,
  index,
  pgEnum,
} from "drizzle-orm/pg-core";
import { patients, prescribers } from "./patients";

export const rxStatusEnum = pgEnum("rx_status", [
  "active",
  "refill_available",
  "refill_soon",
  "ready_for_pickup",
  "out_for_delivery",
  "needs_renewal",
  "expired",
  "discontinued",
]);

export const drugs = pgTable("drugs", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 160 }).notNull(),
  genericName: varchar("generic_name", { length: 160 }),
  ndc: varchar("ndc", { length: 14 }),
  form: varchar("form", { length: 32 }),
  strength: varchar("strength", { length: 32 }),
  description: text("description"),
  uses: text("uses"),
  howToTake: text("how_to_take"),
  sideEffects: text("side_effects"),
  warnings: text("warnings"),
  interactions: text("interactions"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const prescriptions = pgTable(
  "prescriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    drugId: uuid("drug_id").references(() => drugs.id),
    prescriberId: uuid("prescriber_id").references(() => prescribers.id),
    rxNumber: varchar("rx_number", { length: 32 }).notNull(),
    sig: text("sig").notNull(),
    qtyPerFill: integer("qty_per_fill").notNull(),
    daysSupply: integer("days_supply").notNull(),
    refillsTotal: integer("refills_total").notNull().default(0),
    refillsRemaining: integer("refills_remaining").notNull().default(0),
    purpose: text("purpose"),
    status: rxStatusEnum("status").notNull().default("active"),
    pricePerFill: numeric("price_per_fill", { precision: 10, scale: 2 }),
    lastFilledAt: date("last_filled_at"),
    nextRefillAt: date("next_refill_at"),
    expiresAt: date("expires_at"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    patientIdx: index("rx_patient_idx").on(t.patientId),
    statusIdx: index("rx_status_idx").on(t.status),
    rxNumIdx: index("rx_number_idx").on(t.rxNumber),
  }),
);

export const refillEvents = pgTable(
  "refill_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    prescriptionId: uuid("prescription_id")
      .notNull()
      .references(() => prescriptions.id, { onDelete: "cascade" }),
    filledAt: timestamp("filled_at", { withTimezone: true }).notNull(),
    qty: integer("qty").notNull(),
    pricePaid: numeric("price_paid", { precision: 10, scale: 2 }),
    pharmacyId: uuid("pharmacy_id"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    rxIdx: index("refill_rx_idx").on(t.prescriptionId),
  }),
);
