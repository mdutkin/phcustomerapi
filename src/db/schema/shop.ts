// OTC products and shopping cart. Cart belongs to a portal user, not a
// clinical patient.

import {
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
  integer,
  numeric,
  boolean,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./auth";

export const otcProducts = pgTable(
  "otc_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sku: varchar("sku", { length: 32 }).notNull().unique(),
    name: varchar("name", { length: 200 }).notNull(),
    brand: varchar("brand", { length: 120 }),
    category: varchar("category", { length: 80 }).notNull(),
    pack: varchar("pack", { length: 80 }),
    price: numeric("price", { precision: 10, scale: 2 }).notNull(),
    salePrice: numeric("sale_price", { precision: 10, scale: 2 }),
    rating: numeric("rating", { precision: 2, scale: 1 }),
    iconKey: varchar("icon_key", { length: 32 }),
    description: text("description"),
    inStock: boolean("in_stock").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    categoryIdx: index("otc_category_idx").on(t.category),
  }),
);

// Live cart per user. Stale carts cleaned up periodically.
export const carts = pgTable(
  "carts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" })
      .unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const cartItems = pgTable(
  "cart_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cartId: uuid("cart_id")
      .notNull()
      .references(() => carts.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => otcProducts.id, { onDelete: "cascade" }),
    qty: integer("qty").notNull().default(1),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    cartIdx: index("cart_items_cart_idx").on(t.cartId),
  }),
);
