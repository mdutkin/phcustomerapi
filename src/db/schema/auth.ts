// Auth & identity tables.

import {
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// One row per human / login identity. References patient_id when the account
// has been linked to a patient record (most do — but admin/staff accounts
// would not).
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: varchar("email", { length: 254 }),
    phoneE164: varchar("phone_e164", { length: 20 }),
    passwordHash: text("password_hash"),
    googleSub: varchar("google_sub", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (t) => ({
    emailIdx: uniqueIndex("users_email_uniq").on(t.email),
    phoneIdx: uniqueIndex("users_phone_uniq").on(t.phoneE164),
    googleIdx: uniqueIndex("users_google_uniq").on(t.googleSub),
  }),
);

// One-time passcodes for phone (and later email) login.
export const otpChallenges = pgTable(
  "otp_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phoneE164: varchar("phone_e164", { length: 20 }).notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: text("attempts").notNull().default("0"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    phoneIdx: index("otp_phone_idx").on(t.phoneE164),
    expiresIdx: index("otp_expires_idx").on(t.expiresAt),
  }),
);

// Refresh tokens — one row per active session/device. Hashed at rest.
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    userAgent: text("user_agent"),
    ip: varchar("ip", { length: 45 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("refresh_user_idx").on(t.userId),
  }),
);
