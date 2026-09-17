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
import { getWorklistSnapshot } from "./worklist.service";
import { listStaffCommands, transitionCommand } from "./requests.service";
import { commandStatusEnum, commandTypeEnum } from "@/db/schema";

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

  // The aggregated refill work list. Every read is PHI for many patients, so it
  // is audit-logged with the filters used.
  app.get("/staff/worklist", {
    onRequest: [app.authenticate, app.requireRole("pharmacist", "admin")],
    schema: {
      tags: ["staff"],
      summary: "Refill work list across both PrimeRX databases, one row per person",
      querystring: z.object({
        db: z.enum(["340b", "conventional", "both"]).default("both"),
        consent: z.enum(["any", "yes", "no"]).default("any"),
        ranOut: z.enum(["any", "yes"]).default("any"),
        refresh: z.enum(["true", "false"]).default("false"),
        limit: z.coerce.number().int().min(1).max(2000).default(500),
      }),
      response: {
        200: z.object({
          generatedAt: z.string(),
          totals: z.object({
            people: z.number(),
            rx: z.number(),
            withConsent: z.number(),
            ranOut: z.number(),
            byDb: z.record(z.object({ people: z.number(), rx: z.number() })),
          }),
          matched: z.number(),
          people: z.array(
            z.object({
              key: z.string(),
              lastName: z.string().nullable(),
              firstName: z.string().nullable(),
              dob: z.string().nullable(),
              mobile: z.string().nullable(),
              phone: z.string().nullable(),
              languageNo: z.number().nullable(),
              records: z.array(z.object({ db: z.enum(["340b", "conventional"]), patientno: z.number() })),
              rxCount: z.number(),
              consentCount: z.number(),
              ranOutCount: z.number(),
              mostOverdueDays: z.number(),
              hasPortalRequest: z.boolean(),
              priority: z.number(),
              rx: z.array(
                z.object({
                  db: z.enum(["340b", "conventional"]),
                  patientno: z.number(),
                  rxno: z.string(),
                  drugName: z.string().nullable(),
                  drugStrength: z.string().nullable(),
                  deaClass: z.number(),
                  lastFilledAt: z.string().nullable(),
                  daysSupply: z.number().nullable(),
                  refillsRemaining: z.number(),
                  daysRemaining: z.number().nullable(),
                  dueDate: z.string().nullable(),
                  consentUntil: z.string().nullable(),
                  handoff: z.enum(["delivery", "pickup"]),
                  inPrimeRxQueueSince: z.string().nullable(),
                  portalRequestId: z.string().nullable(),
                  portalRequestedAt: z.string().nullable(),
                }),
              ),
            }),
          ),
        }),
      },
    },
  }, async (req) => {
    const q = req.query;
    const snap = await getWorklistSnapshot({ refresh: q.refresh === "true" });
    let people = snap.people;
    if (q.db !== "both") {
      // Keep the person, but only the Rx that live in the chosen database.
      people = people
        .map((p) => ({ ...p, rx: p.rx.filter((r) => r.db === q.db) }))
        .filter((p) => p.rx.length > 0);
    }
    if (q.consent === "yes") people = people.filter((p) => p.rx.some((r) => r.consentUntil));
    if (q.consent === "no") people = people.filter((p) => !p.rx.some((r) => r.consentUntil));
    if (q.ranOut === "yes") people = people.filter((p) => p.rx.some((r) => (r.daysRemaining ?? 0) < 0));
    await recordAudit(req, {
      action: "staff.worklist.view",
      resourceType: "worklist",
      metadata: { db: q.db, consent: q.consent, ranOut: q.ranOut, matched: people.length },
    });
    return { generatedAt: snap.generatedAt, totals: snap.totals, matched: people.length, people: people.slice(0, q.limit) };
  });

  // ─── Command queue (patient requests) ───────────────────────────────────

  const staffCommand = z.object({
    id: z.string().uuid(),
    type: z.enum(commandTypeEnum.enumValues),
    status: z.enum(commandStatusEnum.enumValues),
    dbKind: z.enum(["340b", "conventional"]),
    patientno: z.number(),
    patient: z
      .object({
        lastName: z.string().nullable(),
        firstName: z.string().nullable(),
        dob: z.string().nullable(),
        mobile: z.string().nullable(),
      })
      .nullable(),
    requestedBy: z.object({ userId: z.string(), phoneE164: z.string().nullable(), email: z.string().nullable() }),
    payload: z.record(z.unknown()),
    patientNote: z.string().nullable(),
    staffNote: z.string().nullable(),
    requestedAt: z.string(),
    claimedBy: z.string().nullable(),
    claimedAt: z.string().nullable(),
    completedBy: z.string().nullable(),
    completedAt: z.string().nullable(),
  });

  app.get("/staff/requests", {
    onRequest: [app.authenticate, app.requireRole("pharmacist", "admin")],
    schema: {
      tags: ["staff"],
      summary: "Command queue — everything patients have asked the pharmacy to do",
      querystring: z.object({
        scope: z.enum(["open", "closed", "all"]).default("open"),
        type: z.enum(commandTypeEnum.enumValues).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      }),
      response: { 200: z.object({ items: z.array(staffCommand) }) },
    },
  }, async (req) => {
    const items = await listStaffCommands(req.query);
    await recordAudit(req, { action: "staff.requests.list", resourceType: "command", metadata: { ...req.query, count: items.length } });
    return { items };
  });

  app.post("/staff/requests/:id/:action", {
    onRequest: [app.authenticate, app.requireRole("pharmacist", "admin")],
    schema: {
      tags: ["staff"],
      summary: "Move a request: claim / release / done / reject",
      params: z.object({ id: z.string().uuid(), action: z.enum(["claim", "release", "done", "reject"]) }),
      body: z.object({ note: z.string().max(2000).optional() }).optional(),
      response: { 200: z.object({ id: z.string().uuid(), status: z.enum(commandStatusEnum.enumValues) }) },
    },
  }, async (req) => {
    const actor = req.user.email ?? req.user.firebaseUid;
    const r = await transitionCommand({ id: req.params.id, action: req.params.action, actor, note: req.body?.note ?? null });
    await recordAudit(req, {
      action: `staff.requests.${req.params.action}`,
      resourceType: "command",
      resourceId: req.params.id,
      metadata: { status: r.status, note: req.body?.note ?? null },
    });
    return r;
  });

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
