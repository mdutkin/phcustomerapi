// Smoke test — proves the app boots, plugins register, /health responds.
// Doesn't touch the DB; routes that need it are tested per-module.

import { describe, expect, it, afterAll, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;

beforeAll(async () => {
  // Set required env before the config validator runs. Tests must be hermetic
  // — they stub every required env var rather than rely on .env files.
  process.env.NODE_ENV ||= "test";
  process.env.JWT_SECRET ||= "test_secret_must_be_at_least_32_characters_long";
  process.env.DATABASE_URL ||= "postgres://postgres:postgres@localhost:5432/phcustomerapi_test";
  process.env.MSSQL_HOST ||= "127.0.0.1";
  process.env.MSSQL_PORT ||= "1433";
  process.env.MSSQL_USER ||= "test_user";
  process.env.MSSQL_PASSWORD ||= "test_password";
  process.env.MSSQL_DB_340B ||= "TestPharmSQL";
  process.env.MSSQL_DB_CONVENTIONAL ||= "TestPharmSQLCONVENTIONAL";

  const { buildApp } = await import("../src/app");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("/health", () => {
  it("returns ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe("phcustomerapi");
  });
});

describe("/auth/otp/request", () => {
  it("rejects malformed phone", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/otp/request",
      payload: { phone: "not-a-phone" },
    });
    // Will fail at Zod (min length) or downstream phone validator.
    expect([400, 500]).toContain(res.statusCode);
  });
});
