// One-shot connectivity probe. Verifies both 340B and Conventional pools
// open and a SELECT 1 round-trips. Run with: npx tsx scripts/check-mssql.ts
//
// Requires the MSSQL tunnel for local dev:
//   ssh -L 1433:192.168.0.107:1433 pha-old

import { closeMssqlPools, mssql340b, mssqlConventional } from "@/db/mssql";

async function probe(name: string, getPool: () => Promise<{ request: () => { query: (sql: string) => Promise<{ recordset: Array<Record<string, unknown>> }> } }>) {
  const start = Date.now();
  try {
    const pool = await getPool();
    const r = await pool.request().query(
      "SELECT @@SERVERNAME AS server_name, DB_NAME() AS db_name, (SELECT COUNT(*) FROM sys.tables) AS table_count",
    );
    const row = r.recordset[0];
    // eslint-disable-next-line no-console
    console.log(`✓ ${name}: ${Date.now() - start}ms — server=${row?.server_name} db=${row?.db_name} tables=${row?.table_count}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`✗ ${name}: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

async function main() {
  await probe("340B           ", mssql340b);
  await probe("Conventional   ", mssqlConventional);
  await closeMssqlPools();
}

void main();
