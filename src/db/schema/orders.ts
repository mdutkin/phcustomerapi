// Orders, deliveries, billing.

import {
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
  integer,
  numeric,
  pgEnum,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { patients } from "./patients";
import { otcProducts } from "./shop";

export const orderStatusEnum = pgEnum("order_status", [
  "pending",
  "paid",
  "preparing",
  "shipped",
  "out_for_delivery",
  "delivered",
  "canceled",
  "refunded",
]);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    orderNumber: varchar("order_number", { length: 24 }).notNull().unique(),
    status: orderStatusEnum("status").notNull().default("pending"),
    subtotal: numeric("subtotal", { precision: 10, scale: 2 }).notNull(),
    tax: numeric("tax", { precision: 10, scale: 2 }).notNull().default("0"),
    shipping: numeric("shipping", { precision: 10, scale: 2 }).notNull().default("0"),
    total: numeric("total", { precision: 10, scale: 2 }).notNull(),
    shippingAddress: jsonb("shipping_address").$type<{
      line1: string;
      line2?: string;
      city: string;
      state: string;
      postalCode: string;
    }>(),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    patientIdx: index("orders_patient_idx").on(t.patientId),
    statusIdx: index("orders_status_idx").on(t.status),
  }),
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => otcProducts.id),
    name: varchar("name", { length: 200 }).notNull(),
    qty: integer("qty").notNull(),
    unitPrice: numeric("unit_price", { precision: 10, scale: 2 }).notNull(),
    lineTotal: numeric("line_total", { precision: 10, scale: 2 }).notNull(),
  },
  (t) => ({
    orderIdx: index("order_items_order_idx").on(t.orderId),
  }),
);

// Includes both shop-order deliveries and Rx fulfillment deliveries.
export const deliveryStatusEnum = pgEnum("delivery_status", [
  "scheduled",
  "preparing",
  "out_for_delivery",
  "delivered",
  "missed",
  "canceled",
]);

export const deliveries = pgTable(
  "deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    prescriptionId: uuid("prescription_id"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    timeWindow: varchar("time_window", { length: 32 }),
    status: deliveryStatusEnum("status").notNull().default("scheduled"),
    items: text("items"),
    driverName: varchar("driver_name", { length: 80 }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    patientIdx: index("deliveries_patient_idx").on(t.patientId),
    scheduledIdx: index("deliveries_scheduled_idx").on(t.scheduledFor),
  }),
);

// Billing — separate from shop orders because it includes office copays,
// lab fees, prescription costs, etc.
export const billingStatusEnum = pgEnum("billing_status", [
  "outstanding",
  "paid",
  "partial",
  "void",
]);

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    invoiceNumber: varchar("invoice_number", { length: 24 }).notNull().unique(),
    description: text("description").notNull(),
    amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
    amountPaid: numeric("amount_paid", { precision: 10, scale: 2 }).notNull().default("0"),
    status: billingStatusEnum("status").notNull().default("outstanding"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
  },
  (t) => ({
    patientIdx: index("invoices_patient_idx").on(t.patientId),
    statusIdx: index("invoices_status_idx").on(t.status),
  }),
);

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    invoiceId: uuid("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
    amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
    method: varchar("method", { length: 32 }).notNull(),
    last4: varchar("last4", { length: 4 }),
    processorRef: varchar("processor_ref", { length: 80 }),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    patientIdx: index("payments_patient_idx").on(t.patientId),
  }),
);

export const paymentMethods = pgTable(
  "payment_methods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    brand: varchar("brand", { length: 24 }).notNull(),
    last4: varchar("last4", { length: 4 }).notNull(),
    expMonth: integer("exp_month").notNull(),
    expYear: integer("exp_year").notNull(),
    processorToken: varchar("processor_token", { length: 120 }),
    isDefault: text("is_default").notNull().default("false"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    patientIdx: index("pm_patient_idx").on(t.patientId),
  }),
);
