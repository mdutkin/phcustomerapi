// Validated runtime config. Loaded once on boot; throws if anything is missing
// or malformed. Import the typed `env` everywhere — never read process.env directly.
//
// Env file load order (later files override earlier):
//   1. .env                         — base (committed; non-secret defaults only)
//   2. .env.local                   — gitignored; local overrides + secrets
//   3. .env.${NODE_ENV}             — committed; env-specific non-secret config
//   4. .env.${NODE_ENV}.local       — gitignored; env-specific secrets
//
// Real secrets (MSSQL_PASSWORD, JWT_SECRET, prod DATABASE_URL) belong in
// .env.local or .env.${NODE_ENV}.local — never in the committed files.

import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";

const NODE_ENV = process.env.NODE_ENV ?? "development";

// Zod's `z.coerce.boolean()` does `Boolean(x)` which makes "false" truthy.
// We want the env-string semantics: "true"/"1"/"yes" → true, anything else → false.
const boolFromEnv = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["true", "1", "yes", "on"].includes(v.toLowerCase())));

// Walk up from this file in case the process is launched from a sub-directory.
// In dev (tsx) cwd is the repo root; in prod (compiled to dist/) it's also the
// repo root because we deploy with the .env files alongside the build.
const cwd = process.cwd();

const envFiles = [
  ".env",
  ".env.local",
  `.env.${NODE_ENV}`,
  `.env.${NODE_ENV}.local`,
];

for (const f of envFiles) {
  const p = resolve(cwd, f);
  if (existsSync(p)) {
    loadDotenv({ path: p, override: true });
  }
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  // ─── Postgres (system of record for users, orders, audit, messaging) ───
  DATABASE_URL: z.string().url(),

  // ─── MSSQL / PrimeRX (system of record for patients, Rx, drugs, prescribers) ───
  // For local dev: open SSH tunnel `ssh -L 1433:192.168.0.107:1433 pha-old`
  // and set MSSQL_HOST=127.0.0.1.
  // For prod (deployed to a host that can reach 192.168.0.107 directly):
  // set MSSQL_HOST=192.168.0.107.
  MSSQL_HOST: z.string().min(1),
  MSSQL_PORT: z.coerce.number().int().positive().default(1433),
  MSSQL_USER: z.string().min(1),
  MSSQL_PASSWORD: z.string().min(1),
  MSSQL_DB_340B: z.string().min(1).default("PharmSQL"),
  MSSQL_DB_CONVENTIONAL: z.string().min(1).default("PharmSQLCONVENTIONAL"),
  MSSQL_ENCRYPT: boolFromEnv.default(false),
  MSSQL_TRUST_SERVER_CERT: boolFromEnv.default(true),
  MSSQL_POOL_MAX: z.coerce.number().int().positive().default(10),
  MSSQL_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 chars"),
  JWT_ISSUER: z.string().default("phcustomerapi"),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL: z.string().default("30d"),

  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  OTP_DEV_CODE: z.string().optional(),

  CORS_ORIGINS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    ),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(200),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("❌ Invalid environment configuration:");
  // eslint-disable-next-line no-console
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

export const isProd = env.NODE_ENV === "production";
export const isDev = env.NODE_ENV === "development";
export const isTest = env.NODE_ENV === "test";

// Hard fail if prod is starting with the example placeholder secret.
if (isProd && env.JWT_SECRET.includes("replace_me")) {
  // eslint-disable-next-line no-console
  console.error("❌ Refusing to start production with placeholder JWT_SECRET");
  process.exit(1);
}
