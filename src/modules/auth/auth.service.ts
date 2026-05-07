// Auth core logic. Routes call into here; tests can hit it directly.

import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { otpChallenges, refreshTokens, users } from "@/db/schema";
import { hashPassword, randomNumericCode, randomToken, sha256Hex, verifyPassword } from "@/lib/crypto";
import { env } from "@/config/env";
import { HttpError } from "@/plugins/error-handler";

const MAX_OTP_ATTEMPTS = 5;

function normalisePhone(raw: string): string {
  const trimmed = raw.replace(/[\s\-()]/g, "");
  if (!/^\+\d{8,15}$/.test(trimmed)) {
    throw new HttpError(400, "invalid_phone", "Phone must be E.164 (+15555550100).");
  }
  return trimmed;
}

export async function issueOtp(rawPhone: string): Promise<{ devCode?: string }> {
  const phoneE164 = normalisePhone(rawPhone);
  const code = env.OTP_DEV_CODE && !env.NODE_ENV.startsWith("prod")
    ? env.OTP_DEV_CODE
    : randomNumericCode(6);
  const codeHash = sha256Hex(code);
  const expiresAt = new Date(Date.now() + env.OTP_TTL_SECONDS * 1000);

  await db.insert(otpChallenges).values({ phoneE164, codeHash, expiresAt });

  // In dev/test we surface the code in the response so the portal can wire E2E tests.
  return env.NODE_ENV === "production" ? {} : { devCode: code };
}

export async function verifyOtp(rawPhone: string, code: string, ctx: { userAgent?: string; ip?: string }) {
  const phoneE164 = normalisePhone(rawPhone);
  const codeHash = sha256Hex(code);
  const now = new Date();

  const [challenge] = await db
    .select()
    .from(otpChallenges)
    .where(
      and(
        eq(otpChallenges.phoneE164, phoneE164),
        gt(otpChallenges.expiresAt, now),
        isNull(otpChallenges.consumedAt),
      ),
    )
    .orderBy(desc(otpChallenges.createdAt))
    .limit(1);

  if (!challenge) throw new HttpError(401, "otp_expired", "No active code. Request a new one.");
  if (Number(challenge.attempts) >= MAX_OTP_ATTEMPTS) {
    throw new HttpError(429, "otp_locked", "Too many attempts. Request a new code.");
  }
  if (challenge.codeHash !== codeHash) {
    await db
      .update(otpChallenges)
      .set({ attempts: String(Number(challenge.attempts) + 1) })
      .where(eq(otpChallenges.id, challenge.id));
    throw new HttpError(401, "otp_invalid", "Code is incorrect.");
  }

  await db
    .update(otpChallenges)
    .set({ consumedAt: now })
    .where(eq(otpChallenges.id, challenge.id));

  // Create user on first sign-in. Patient linkage is a separate flow.
  let user = (await db.select().from(users).where(eq(users.phoneE164, phoneE164)).limit(1))[0];
  if (!user) {
    [user] = await db.insert(users).values({ phoneE164 }).returning();
  }
  if (!user) throw new HttpError(500, "user_create_failed");

  await db.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));

  return mintSession(user.id, ctx);
}

export async function loginEmail(email: string, password: string, ctx: { userAgent?: string; ip?: string }) {
  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (!user || !user.passwordHash) throw new HttpError(401, "invalid_credentials");
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) throw new HttpError(401, "invalid_credentials");

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  return mintSession(user.id, ctx);
}

export async function registerEmail(email: string, password: string, ctx: { userAgent?: string; ip?: string }) {
  const lower = email.toLowerCase();
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, lower)).limit(1);
  if (existing.length > 0) throw new HttpError(409, "email_taken");

  const passwordHash = await hashPassword(password);
  const [user] = await db.insert(users).values({ email: lower, passwordHash }).returning();
  if (!user) throw new HttpError(500, "user_create_failed");
  return mintSession(user.id, ctx);
}

async function mintSession(userId: string, ctx: { userAgent?: string; ip?: string }) {
  const refreshToken = randomToken(48);
  const refreshHash = sha256Hex(refreshToken);
  const ttlMs = parseTtl(env.JWT_REFRESH_TTL);

  const [row] = await db
    .insert(refreshTokens)
    .values({
      userId,
      tokenHash: refreshHash,
      userAgent: ctx.userAgent,
      ip: ctx.ip,
      expiresAt: new Date(Date.now() + ttlMs),
    })
    .returning();
  if (!row) throw new HttpError(500, "session_create_failed");

  return {
    userId,
    refreshToken,
    refreshTokenId: row.id,
  };
}

function parseTtl(s: string): number {
  const m = /^(\d+)([smhd])$/.exec(s);
  if (!m) return 30 * 24 * 60 * 60 * 1000;
  const n = Number(m[1]);
  const unit = m[2];
  const factor = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit ?? "d"] ?? 86_400_000;
  return n * factor;
}

export async function rotateRefresh(rawToken: string) {
  const tokenHash = sha256Hex(rawToken);
  const now = new Date();

  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.tokenHash, tokenHash),
        gt(refreshTokens.expiresAt, now),
        isNull(refreshTokens.revokedAt),
      ),
    )
    .limit(1);
  if (!row) throw new HttpError(401, "invalid_refresh");

  // Rotate: revoke the used token, mint a new one.
  await db.update(refreshTokens).set({ revokedAt: now }).where(eq(refreshTokens.id, row.id));
  return mintSession(row.userId, { userAgent: row.userAgent ?? undefined, ip: row.ip ?? undefined });
}

export async function revokeRefresh(rawToken: string) {
  const tokenHash = sha256Hex(rawToken);
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(eq(refreshTokens.tokenHash, tokenHash));
}
