// Discovers column shape for the PrimeRX tables we care about.
// Output is markdown to stdout — paste into design notes.
//
// Run: NODE_ENV=development npx tsx scripts/inspect-mssql-schema.ts

import { closeMssqlPools, mssql340b } from "@/db/mssql";

const TABLES = ["PATIENT", "PRESCRIB", "DRUG", "CLAIMS", "RXEXTRA", "INSCAR"];

async function main() {
  const pool = await mssql340b();
  for (const t of TABLES) {
    const r = await pool.request().input("t", t).query(`
      SELECT
        c.COLUMN_NAME,
        c.DATA_TYPE,
        c.CHARACTER_MAXIMUM_LENGTH AS max_len,
        c.IS_NULLABLE,
        c.NUMERIC_PRECISION AS num_prec,
        c.NUMERIC_SCALE AS num_scale
      FROM INFORMATION_SCHEMA.COLUMNS c
      WHERE c.TABLE_NAME = @t
      ORDER BY c.ORDINAL_POSITION;
    `);
    // eslint-disable-next-line no-console
    console.log(`\n## ${t} (${r.recordset.length} columns)\n`);
    // eslint-disable-next-line no-console
    console.log("| column | type | nullable |");
    // eslint-disable-next-line no-console
    console.log("|---|---|---|");
    for (const c of r.recordset) {
      const len = c.max_len ? `(${c.max_len})` : c.num_prec ? `(${c.num_prec},${c.num_scale ?? 0})` : "";
      // eslint-disable-next-line no-console
      console.log(`| ${c.COLUMN_NAME} | ${c.DATA_TYPE}${len} | ${c.IS_NULLABLE} |`);
    }

    // Primary keys
    const pk = await pool.request().input("t", t).query(`
      SELECT kc.COLUMN_NAME
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kc ON tc.CONSTRAINT_NAME = kc.CONSTRAINT_NAME
      WHERE tc.TABLE_NAME = @t AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
      ORDER BY kc.ORDINAL_POSITION;
    `);
    if (pk.recordset.length) {
      // eslint-disable-next-line no-console
      console.log(`\n**PK:** ${pk.recordset.map((r2: { COLUMN_NAME: string }) => r2.COLUMN_NAME).join(", ")}`);
    }
  }
  await closeMssqlPools();
}

void main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
