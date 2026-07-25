// Hermetic shape tests. Doesn't hit MSSQL, PG, or Firebase — just verifies the
// app boots and unauthenticated calls to the PHI-protected endpoints get 401,
// not 500. Catches the common breakage class (route registered but plugin
// order wrong, or schema build fails). The auth plugin rejects missing/blank
// Bearer tokens BEFORE any Firebase verification, so these stay hermetic.
//
// The authenticated happy paths (real Firebase ID token → user provisioning →
// 200) are exercised separately against the Firebase Auth emulator, not here.

import { describe, expect, it, afterAll, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;

beforeAll(async () => {
  process.env.NODE_ENV = "test"; // force — host may export NODE_ENV=production
  // Firebase: point at the emulator so plugin init needs no real credentials.
  process.env.FIREBASE_PROJECT_ID ||= "demo-phcustomerapi";
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
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

describe("authentication gates", () => {
  it("rejects unauthenticated /me", async () => {
    const res = await app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects unauthenticated /me/claim", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/me/claim",
      payload: { lastName: "Chen", dob: "1953-03-14", phone: "+14155550192" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects unauthenticated /prescriptions", async () => {
    const res = await app.inject({ method: "GET", url: "/prescriptions" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects unauthenticated /prescriptions/:rxno/refill", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/prescriptions/12345/refill",
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects unauthenticated /requests", async () => {
    const res = await app.inject({ method: "GET", url: "/requests" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects unauthenticated /requests/update-details", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/requests/update-details",
      payload: { phone: "+14155550192" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a malformed Bearer token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("keeps /health open (no auth)", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, service: "phcustomerapi" });
  });
});
