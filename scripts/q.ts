// Ad-hoc READ-ONLY query against PrimeRX. Usage:
//   npx tsx scripts/q.ts [340b|conv] "SELECT TOP 5 ..."
// Refuses anything that isn't a single SELECT/WITH statement — PrimeRX has no API,
// its client writes MSSQL directly, and we must never write there.
import { closeMssqlPools, mssql340b, mssqlConventional } from "@/db/mssql";

async function main() {
  const [dbArg, ...rest] = process.argv.slice(2);
  const sql = rest.join(" ").trim();
  if (!/^(select|with)\b/i.test(sql) || /;\s*\S/.test(sql) || /\b(insert|update|delete|merge|exec|execute|drop|alter|create|truncate|into)\b/i.test(sql.replace(/^with[\s\S]*?\bselect\b/i, "select"))) {
    console.error("refused: read-only SELECT statements only");
    process.exit(2);
  }
  const pool = await (dbArg === "340b" ? mssql340b() : mssqlConventional());
  const t = Date.now();
  const r = await pool.request().query(sql);
  console.log(JSON.stringify(r.recordset, null, 1));
  console.error(`${r.recordset.length} rows, ${Date.now() - t}ms`);
  await closeMssqlPools();
}
void main().catch((e) => { console.error(e.message); process.exit(1); });
