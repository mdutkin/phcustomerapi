// Firebase Authentication plugin.
//
// Firebase is the sole source of truth for auth. This plugin:
//   - initialises the firebase-admin SDK once (real credentials in prod, or the
//     Auth emulator in dev/test via FIREBASE_AUTH_EMULATOR_HOST)
//   - exposes `app.authenticate` (onRequest hook): verifies the caller's
//     Firebase ID token, lazily provisions a local `users` row keyed by the
//     Firebase UID, and sets `req.user`
//
// Downstream route modules keep using `req.user.sub` as the internal users.id,
// so they didn't have to change when we swapped custom JWT → Firebase.

import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest } from "fastify";
import { initializeApp, cert, getApps, type App as FirebaseApp } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users, type UserRole } from "@/db/schema";
import { env } from "@/config/env";

export interface AuthedUser {
  sub: string; // internal users.id (UUID) — unchanged contract for route modules
  firebaseUid: string;
  phone?: string;
  email?: string;
  /** From the verified Firebase custom claim; "patient" when absent. */
  role: UserRole;
  /** True when the ID token was minted after a second factor. */
  mfa: boolean;
}

const ROLES: ReadonlySet<string> = new Set(["patient", "pharmacist", "admin"]);

/** Only ever trust the role that Firebase signed into the token. */
function roleFromClaims(claims: Record<string, unknown>): UserRole {
  const r = claims.role;
  return typeof r === "string" && ROLES.has(r) ? (r as UserRole) : "patient";
}

declare module "fastify" {
  interface FastifyRequest {
    user: AuthedUser;
  }
  interface FastifyInstance {
    /** firebase-admin Auth — for admin routes that manage accounts/claims. */
    firebaseAuth: Auth;
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Route guard: run AFTER authenticate. 403 unless the user holds one of the roles. */
    requireRole: (...roles: UserRole[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

function initFirebase(): FirebaseApp {
  if (getApps().length) return getApps()[0]!;
  // Emulator mode: firebase-admin reads FIREBASE_AUTH_EMULATOR_HOST itself and
  // skips credential verification — only a projectId is needed.
  if (env.FIREBASE_AUTH_EMULATOR_HOST) {
    return initializeApp({ projectId: env.FIREBASE_PROJECT_ID });
  }
  // Preferred for prod: point at the service-account JSON file on disk. cert()
  // reads + parses it itself, so we never have to shuttle a PEM private key
  // through an env var (which mangles newlines → ERR_OSSL_UNSUPPORTED).
  if (env.FIREBASE_SERVICE_ACCOUNT_FILE) {
    return initializeApp({
      projectId: env.FIREBASE_PROJECT_ID,
      credential: cert(env.FIREBASE_SERVICE_ACCOUNT_FILE),
    });
  }
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error(
      "Set FIREBASE_SERVICE_ACCOUNT_FILE (path) or FIREBASE_SERVICE_ACCOUNT_JSON when not using the auth emulator",
    );
  }
  const svc = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON) as {
    project_id: string;
    client_email: string;
    private_key: string;
  };
  return initializeApp({
    projectId: env.FIREBASE_PROJECT_ID,
    credential: cert({
      projectId: svc.project_id,
      clientEmail: svc.client_email,
      // Env-encoded private keys carry literal "\n" — normalise to real newlines.
      privateKey: svc.private_key.replace(/\\n/g, "\n"),
    }),
  });
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return null;
  const t = h.slice(7).trim();
  return t.length > 0 ? t : null;
}

// Find-or-create the local user for a verified Firebase identity.
async function provisionUser(claims: {
  uid: string;
  phone?: string;
  email?: string;
  role: UserRole;
  mfa: boolean;
}): Promise<AuthedUser> {
  const now = new Date();
  const base = {
    firebaseUid: claims.uid,
    phone: claims.phone,
    email: claims.email,
    role: claims.role,
    mfa: claims.mfa,
  };
  const existing = (
    await db.select().from(users).where(eq(users.firebaseUid, claims.uid)).limit(1)
  )[0];

  if (existing) {
    // Keep the PG mirror in step with the claim: it changes when an admin
    // promotes/demotes someone, and the token picks that up on refresh.
    await db
      .update(users)
      .set({ lastLoginAt: now, ...(existing.role !== claims.role ? { role: claims.role } : {}) })
      .where(eq(users.id, existing.id));
    return { sub: existing.id, ...base };
  }

  // Same phone, new Firebase UID — re-bind rather than fail.
  //
  // A Firebase account can be recreated (the user deletes and re-registers, an
  // admin removes it, or in dev the Auth emulator restarts and loses its store).
  // The phone then arrives with a fresh uid while our users row still holds the
  // old one, and inserting collides with the unique phone constraint — locking
  // the person out of their own claimed patient record behind an opaque 401.
  //
  // Adopting the row is consistent with our identity model rather than a
  // shortcut: a Firebase-verified phone IS our proof of possession, and it's the
  // same standard we require to claim a patient in the first place. Whoever
  // controls the number is the same person, so the links stay theirs.
  if (claims.phone) {
    const byPhone = (
      await db.select().from(users).where(eq(users.phoneE164, claims.phone)).limit(1)
    )[0];
    if (byPhone) {
      await db
        .update(users)
        .set({ firebaseUid: claims.uid, lastLoginAt: now, role: claims.role })
        .where(eq(users.id, byPhone.id));
      return { sub: byPhone.id, ...base };
    }
  }

  const [created] = await db
    .insert(users)
    .values({
      firebaseUid: claims.uid,
      phoneE164: claims.phone ?? null,
      email: claims.email ?? null,
      role: claims.role,
      lastLoginAt: now,
    })
    .returning();
  if (!created) throw new Error("user provisioning failed");
  return { sub: created.id, ...base };
}

export default fp(
  async (app) => {
    const fbApp = initFirebase();
    const auth = getAuth(fbApp);
    app.decorate("firebaseAuth", auth);

    app.decorate("authenticate", async function (req, reply) {
      const token = bearer(req);
      if (!token) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      try {
        const decoded = await auth.verifyIdToken(token);
        const role = roleFromClaims(decoded as Record<string, unknown>);
        const mfa = typeof decoded.firebase?.sign_in_second_factor === "string";
        // A staff account can read every patient — in production it must not
        // hang off a single factor.
        if (role !== "patient" && env.STAFF_REQUIRE_MFA && !mfa) {
          return reply.code(403).send({ error: "mfa_required" });
        }
        req.user = await provisionUser({
          uid: decoded.uid,
          phone: decoded.phone_number ?? undefined,
          email: decoded.email ?? undefined,
          role,
          mfa,
        });
      } catch (err) {
        req.log.debug({ err }, "firebase token verification failed");
        return reply.code(401).send({ error: "unauthorized" });
      }
    });

    app.decorate("requireRole", function (...roles: UserRole[]) {
      return async function (req: FastifyRequest, reply: FastifyReply) {
        if (!req.user || !roles.includes(req.user.role)) {
          return reply.code(403).send({ error: "forbidden" });
        }
      };
    });
  },
  { name: "auth-firebase" },
);
