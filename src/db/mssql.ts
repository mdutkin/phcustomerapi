// Read-only MSSQL clients for the existing PrimeRX databases.
//
// Two separate connection pools, one per database (PharmSQL = 340B,
// PharmSQLCONVENTIONAL = Conventional). Both target the same server.
//
// Pools are lazy: first call to `mssql340b()` / `mssqlConventional()`
// opens the pool. They are then reused for the life of the process.
// Call `closeMssqlPools()` from the graceful shutdown path.
//
// IMPORTANT: This service must NEVER write to MSSQL. PrimeRX is the
// system of record on the pharmacy side. Only SELECTs from here.

import mssql from "mssql";
import { env } from "@/config/env";

type Pool = mssql.ConnectionPool;

const baseConfig: mssql.config = {
  server: env.MSSQL_HOST,
  port: env.MSSQL_PORT,
  user: env.MSSQL_USER,
  password: env.MSSQL_PASSWORD,
  pool: {
    max: env.MSSQL_POOL_MAX,
    min: 0,
    idleTimeoutMillis: 30_000,
  },
  options: {
    encrypt: env.MSSQL_ENCRYPT,
    trustServerCertificate: env.MSSQL_TRUST_SERVER_CERT,
    enableArithAbort: true,
    appName: "phcustomerapi",
  },
  requestTimeout: env.MSSQL_REQUEST_TIMEOUT_MS,
  connectionTimeout: 15_000,
};

let pool340b: Pool | null = null;
let poolConventional: Pool | null = null;

async function openPool(database: string): Promise<Pool> {
  const pool = new mssql.ConnectionPool({ ...baseConfig, database });
  pool.on("error", (err) => {
    // Pool-level error (lost connection etc). Log and let next call reconnect.
    // eslint-disable-next-line no-console
    console.error(`[mssql:${database}] pool error:`, err.message);
  });
  await pool.connect();
  return pool;
}

export async function mssql340b(): Promise<Pool> {
  if (!pool340b) pool340b = await openPool(env.MSSQL_DB_340B);
  return pool340b;
}

export async function mssqlConventional(): Promise<Pool> {
  if (!poolConventional) poolConventional = await openPool(env.MSSQL_DB_CONVENTIONAL);
  return poolConventional;
}

export type MssqlKind = "340b" | "conventional";

export async function getMssqlPool(kind: MssqlKind): Promise<Pool> {
  return kind === "340b" ? mssql340b() : mssqlConventional();
}

export async function closeMssqlPools(): Promise<void> {
  await Promise.allSettled([pool340b?.close(), poolConventional?.close()]);
  pool340b = null;
  poolConventional = null;
}

/**
 * Lightweight ping for /health. Returns whichever pools succeeded.
 * Does NOT throw — health checks should never crash on transient DB issues.
 */
export async function pingMssql(): Promise<{
  pharmSql: { ok: boolean; error?: string };
  pharmSqlConventional: { ok: boolean; error?: string };
}> {
  const ping = async (kind: MssqlKind) => {
    try {
      const p = await getMssqlPool(kind);
      await p.request().query("SELECT 1 AS ok");
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  };
  const [a, b] = await Promise.all([ping("340b"), ping("conventional")]);
  return { pharmSql: a, pharmSqlConventional: b };
}
