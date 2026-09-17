// Auth & identity tables.
//
// Firebase is the sole source of truth for authentication (phone sign-in for
// v1). We do NOT store passwords, OTP challenges, or refresh tokens — Firebase
// owns the SMS code, session, and token refresh. This table is just the portal's
// local mirror of "who is this Firebase user in OUR world", keyed by the stable
// Firebase UID. Patient linkage (PrimeRX/NextGen) is a separate flow.

import {
  pgEnum,
  pgTable,
  timestamp,
  uuid,
  varchar,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Who this account is in the pharmacy's world.
 * - patient    — the default; phone sign-in, sees only their own linked records.
 * - pharmacist — staff; email+password (+MFA in prod), works queues and lists.
 * - admin      — staff who can also manage staff accounts and settings.
 * Source of truth is the Firebase custom claim `role`; this column is a mirror
 * so SQL joins/reports can filter without a Firebase round-trip.
 */
export const userRoleEnum = pgEnum("user_role", ["patient", "pharmacist", "admin"]);
export type UserRole = (typeof userRoleEnum.enumValues)[number];

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Stable Firebase Authentication UID — the identity key. Set on first
    // authenticated request (lazy provisioning in the auth plugin).
    firebaseUid: varchar("firebase_uid", { length: 128 }).notNull(),
    // Mirrored from the verified Firebase token for convenience/lookup. Source
    // of truth for these stays in Firebase.
    phoneE164: varchar("phone_e164", { length: 20 }),
    email: varchar("email", { length: 254 }),
    role: userRoleEnum("role").notNull().default("patient"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (t) => ({
    firebaseIdx: uniqueIndex("users_firebase_uid_uniq").on(t.firebaseUid),
    phoneIdx: uniqueIndex("users_phone_uniq").on(t.phoneE164),
    emailIdx: uniqueIndex("users_email_uniq").on(t.email),
  }),
);
