// Staff & admin routes.
//
// Roles come from the Firebase custom claim `role` (see plugins/auth.ts) and are
// enforced with app.requireRole AFTER app.authenticate. Everything under
// /staff/* is for pharmacists and admins; /admin/* is admin-only and is the ONLY
// place a role can be granted — there is no self-service path to staff.
//
// Staff sign in with email+password (never offered on the patient login page)
// and, in production, must present a second factor (STAFF_REQUIRE_MFA).

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users, userRoleEnum } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { HttpError } from "@/plugins/error-handler";

const roleSchema = z.enum(userRoleEnum.enumValues);
const staffRoleSchema = z.enum(["pharmacist", "admin"]);

const userSummary = z.object({
  id: z.string().uuid(),
  firebaseUid: z.string(),
  email: z.string().nullable(),
  phoneE164: z.string().nullable(),
  role: roleSchema,
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
});

export const staffRoutes: FastifyPluginAsyncZod = async (app) => {
  // ─── /staff — pharmacist + admin ────────────────────────────────────────

  app.get("/staff/me", {
    onRequest: [app.authenticate, app.requireRole("pharmacist", "admin")],
    schema: {
      tags: ["staff"],
      summary: "Who am I (staff) — role and MFA state",
      response: {
        200: z.object({
          id: z.string().uuid(),
          email: z.string().nullable(),
          role: roleSchema,
          mfa: z.boolean(),
        }),
      },
    },
  }, async (req) => ({
    id: req.user.sub,
    email: req.user.email ?? null,
    role: req.user.role,
    mfa: req.user.mfa,
  }));

  // ─── /admin — admin only ────────────────────────────────────────────────

  app.get("/admin/users", {
    onRequest: [app.authenticate, app.requireRole("admin")],
    schema: {
      tags: ["admin"],
      summary: "List portal accounts (staff first)",
      querystring: z.object({ role: roleSchema.optional() }),
      response: { 200: z.object({ items: z.array(userSummary) }) },
    },
  }, async (req) => {
    const rows = await db
      .select()
      .from(users)
      .where(req.query.role ? eq(users.role, req.query.role) : undefined)
      .orderBy(desc(users.role), desc(users.lastLoginAt))
      .limit(500);
    await recordAudit(req, { action: "admin.users.list", resourceType: "user" });
    return {
      items: rows.map((u) => ({
        id: u.id,
        firebaseUid: u.firebaseUid,
        email: u.email,
        phoneE164: u.phoneE164,
        role: u.role,
        createdAt: u.createdAt.toISOString(),
        lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      })),
    };
  });

  // Create a staff account. Email+password in Firebase, role claim set at
  // creation so the very first sign-in already carries it. The temp password
  // is returned ONCE; the person changes it on first login.
  app.post("/admin/users", {
    onRequest: [app.authenticate, app.requireRole("admin")],
    schema: {
      tags: ["admin"],
      summary: "Create a staff account (email + password) with a role",
      body: z.object({
        email: z.string().email(),
        displayName: z.string().min(1).max(120).optional(),
        role: staffRoleSchema,
        password: z.string().min(12).max(128).optional(),
      }),
      response: {
        201: z.object({
          firebaseUid: z.string(),
          email: z.string(),
          role: staffRoleSchema,
          temporaryPassword: z.string().nullable(),
        }),
      },
    },
  }, async (req, reply) => {
    const { email, displayName, role } = req.body;
    const password = req.body.password ?? generatePassword();
    let uid: string;
    try {
      const created = await app.firebaseAuth.createUser({ email, password, displayName, emailVerified: true });
      uid = created.uid;
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      if (code === "auth/email-already-exists") throw new HttpError(409, "email_already_exists");
      throw err;
    }
    await app.firebaseAuth.setCustomUserClaims(uid, { role });
    await db
      .insert(users)
      .values({ firebaseUid: uid, email, role })
      .onConflictDoUpdate({ target: users.email, set: { firebaseUid: uid, role } });
    await recordAudit(req, {
      action: "admin.users.create",
      resourceType: "user",
      resourceId: uid,
      metadata: { email, role },
    });
    return reply.code(201).send({
      firebaseUid: uid,
      email,
      role,
      temporaryPassword: req.body.password ? null : password,
    });
  });

  // Grant / change a role. Setting "patient" is how you revoke staff access.
  app.put("/admin/users/:firebaseUid/role", {
    onRequest: [app.authenticate, app.requireRole("admin")],
    schema: {
      tags: ["admin"],
      summary: "Set a user's role (Firebase custom claim + PG mirror)",
      params: z.object({ firebaseUid: z.string().min(1) }),
      body: z.object({ role: roleSchema }),
      response: { 200: z.object({ firebaseUid: z.string(), role: roleSchema }) },
    },
  }, async (req) => {
    const { firebaseUid } = req.params;
    const { role } = req.body;
    if (firebaseUid === req.user.firebaseUid && role !== "admin") {
      // Locking yourself out is never what you meant.
      throw new HttpError(409, "cannot_demote_self");
    }
    // Patients are phone-only identities; a staff role on a phone-only account
    // would sidestep the email+MFA requirement.
    const fbUser = await app.firebaseAuth.getUser(firebaseUid).catch(() => null);
    if (!fbUser) throw new HttpError(404, "user_not_found");
    if (role !== "patient" && !fbUser.email) throw new HttpError(409, "staff_requires_email_account");

    const existingClaims = fbUser.customClaims ?? {};
    await app.firebaseAuth.setCustomUserClaims(firebaseUid, { ...existingClaims, role });
    // Force every existing session to re-mint its token with the new claim.
    await app.firebaseAuth.revokeRefreshTokens(firebaseUid);
    await db
      .insert(users)
      .values({ firebaseUid, email: fbUser.email ?? null, phoneE164: fbUser.phoneNumber ?? null, role })
      .onConflictDoUpdate({ target: users.firebaseUid, set: { role } });
    await recordAudit(req, {
      action: "admin.users.set_role",
      resourceType: "user",
      resourceId: firebaseUid,
      metadata: { role, previous: existingClaims.role ?? "patient" },
    });
    return { firebaseUid, role };
  });
};

function generatePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%";
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}
