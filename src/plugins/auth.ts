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
import { getAuth } from "firebase-admin/auth";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { env } from "@/config/env";

export interface AuthedUser {
  sub: string; // internal users.id (UUID) — unchanged contract for route modules
  firebaseUid: string;
  phone?: string;
  email?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user: AuthedUser;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
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
}): Promise<AuthedUser> {
  const now = new Date();
  const existing = (
    await db.select().from(users).where(eq(users.firebaseUid, claims.uid)).limit(1)
  )[0];

  if (existing) {
    await db.update(users).set({ lastLoginAt: now }).where(eq(users.id, existing.id));
    return { sub: existing.id, firebaseUid: claims.uid, phone: claims.phone, email: claims.email };
  }

  const [created] = await db
    .insert(users)
    .values({
      firebaseUid: claims.uid,
      phoneE164: claims.phone ?? null,
      email: claims.email ?? null,
      lastLoginAt: now,
    })
    .returning();
  if (!created) throw new Error("user provisioning failed");
  return { sub: created.id, firebaseUid: claims.uid, phone: claims.phone, email: claims.email };
}

export default fp(
  async (app) => {
    const fbApp = initFirebase();
    const auth = getAuth(fbApp);

    app.decorate("authenticate", async function (req, reply) {
      const token = bearer(req);
      if (!token) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      try {
        const decoded = await auth.verifyIdToken(token);
        req.user = await provisionUser({
          uid: decoded.uid,
          phone: decoded.phone_number ?? undefined,
          email: decoded.email ?? undefined,
        });
      } catch (err) {
        req.log.debug({ err }, "firebase token verification failed");
        return reply.code(401).send({ error: "unauthorized" });
      }
    });
  },
  { name: "auth-firebase" },
);
