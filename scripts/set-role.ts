// Bootstrap / break-glass role management. The API's /admin routes need an
// admin to call them, so the FIRST admin has to come from here, on the box,
// with the service account.
//
//   NODE_ENV=production npx tsx scripts/set-role.ts <email> admin|pharmacist|patient [--create] [--password '...']
//
// --create makes the Firebase email+password account if it doesn't exist and
// prints a temporary password once. Sets the `role` custom claim, revokes
// existing sessions so the claim takes effect, and mirrors the role into PG.
import { getAuth } from "firebase-admin/auth";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { env } from "@/config/env";
import { db, pool } from "@/db/client";
import { users } from "@/db/schema";

const ROLES = ["patient", "pharmacist", "admin"] as const;
type Role = (typeof ROLES)[number];

function app() {
  if (getApps().length) return getApps()[0]!;
  if (env.FIREBASE_AUTH_EMULATOR_HOST) return initializeApp({ projectId: env.FIREBASE_PROJECT_ID });
  if (env.FIREBASE_SERVICE_ACCOUNT_FILE) {
    return initializeApp({ projectId: env.FIREBASE_PROJECT_ID, credential: cert(env.FIREBASE_SERVICE_ACCOUNT_FILE) });
  }
  const svc = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON ?? "{}") as { project_id: string; client_email: string; private_key: string };
  return initializeApp({
    projectId: env.FIREBASE_PROJECT_ID,
    credential: cert({ projectId: svc.project_id, clientEmail: svc.client_email, privateKey: svc.private_key.replace(/\\n/g, "\n") }),
  });
}

function randomPassword(): string {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%";
  const b = new Uint8Array(20);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => a[x % a.length]).join("");
}

async function main() {
  const [email, roleArg, ...flags] = process.argv.slice(2);
  const role = roleArg as Role;
  if (!email || !ROLES.includes(role)) {
    console.error("usage: set-role.ts <email> <patient|pharmacist|admin> [--create] [--password '...']");
    process.exit(2);
  }
  const create = flags.includes("--create");
  const pwIdx = flags.indexOf("--password");
  const password = pwIdx >= 0 ? flags[pwIdx + 1] : undefined;

  const auth = getAuth(app());
  let user = await auth.getUserByEmail(email).catch(() => null);
  let tempPassword: string | null = null;
  if (!user) {
    if (!create) {
      console.error(`no Firebase user with email ${email}; pass --create to make one`);
      process.exit(1);
    }
    tempPassword = password ?? randomPassword();
    user = await auth.createUser({ email, password: tempPassword, emailVerified: true });
    console.log(`created ${email} (${user.uid})`);
  } else if (password) {
    await auth.updateUser(user.uid, { password });
    console.log("password updated");
  }
  if (role !== "patient" && !user.email) {
    console.error("staff roles require an email+password account, not a phone-only one");
    process.exit(1);
  }
  await auth.setCustomUserClaims(user.uid, { ...(user.customClaims ?? {}), role });
  await auth.revokeRefreshTokens(user.uid);
  await db
    .insert(users)
    .values({ firebaseUid: user.uid, email: user.email ?? null, phoneE164: user.phoneNumber ?? null, role })
    .onConflictDoUpdate({ target: users.firebaseUid, set: { role, email: user.email ?? null } });
  console.log(`${email} → role=${role} (uid ${user.uid})`);
  if (tempPassword) console.log(`temporary password (shown once): ${tempPassword}`);
  await pool.end();
}

void main().catch((e) => { console.error(e); process.exit(1); });
