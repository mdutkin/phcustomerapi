// Smoke test — proves the app boots, plugins register, /health responds.
// Doesn't touch the DB; routes that need it are tested per-module.

import { describe, expect, it, afterAll, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;

beforeAll(async () => {
  // Set required env before the config validator runs.
  process.env.NODE_ENV ||= "test";
  process.env.JWT_SECRET ||= "test_secret_must_be_at_least_32_characters_long";
  process.env.DATABASE_URL ||= "postgres://postgres:postgres@localhost:5432/phcustomerapi";

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
