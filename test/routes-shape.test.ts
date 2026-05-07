// Hermetic shape tests for the new hybrid routes. Doesn't hit MSSQL or
// PG — just verifies the app boots and unauthenticated calls to the
// PHI-protected endpoints get 401, not 500. This catches the most
// common breakage class (route registered but plugin order wrong, or
// schema build fails).

import { describe, expect, it, afterAll, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;

beforeAll(async () => {
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
});

describe("body validation", () => {
  it("rejects malformed claim payload at the schema layer", async () => {
    // Forge a token to exercise the claim route's body validator
    // without needing a real PG/MSSQL stack.
    const accessToken = app.jwt.sign(
      { sub: "00000000-0000-0000-0000-000000000000", type: "access" },
      { expiresIn: "1m" },
    );
    const res = await app.inject({
      method: "POST",
      url: "/me/claim",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { lastName: "", dob: "not-a-date", phone: "1" },
    });
    expect(res.statusCode).toBe(400);
  });
});
