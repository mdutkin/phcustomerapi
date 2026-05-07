// Smoke-tests /health/deep against an in-process Fastify instance.
// Useful for confirming MSSQL pools come up via the env-driven config path.
//
// Run with: NODE_ENV=development npx tsx scripts/probe-deep-health.ts
// (Requires SSH tunnel for dev: `ssh -L 1433:192.168.0.107:1433 pha-old`.)

import { buildApp } from "@/app";
import { closeMssqlPools } from "@/db/mssql";
import { pool } from "@/db/client";

async function main() {
  const app = await buildApp();
  try {
    const res = await app.inject({ method: "GET", url: "/health/deep" });
    // eslint-disable-next-line no-console
    console.log("status:", res.statusCode);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(res.json(), null, 2));
  } finally {
    await app.close();
    await Promise.allSettled([pool.end(), closeMssqlPools()]);
  }
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
