// DRUG — drug lookup by NDC.

import type { IRecordSet } from "mssql";
import { getMssqlPool } from "@/db/mssql";
import type { DbKind, PrimeRxDrug } from "./types";

interface DrugRow {
  DRGNDC: string;
  DRGNAME: string | null;
  DRGBRNAME: string | null;
  DRGGENNAME: string | null;
  FORM: string | null;
  STRONG: string | null;
  UNITS: string | null;
  CLASS: string | number | null;
}

function rowToDrug(r: DrugRow): PrimeRxDrug {
  return {
    ndc: r.DRGNDC.trim(),
    name: r.DRGNAME?.trim() || null,
    brandName: r.DRGBRNAME?.trim() || null,
    genericName: r.DRGGENNAME?.trim() || null,
    form: r.FORM?.trim() || null,
    strength: r.STRONG?.trim() || null,
    units: r.UNITS?.trim() || null,
    // DEA schedule: 0 = not controlled, 2..5 = CII..CV. Anything non-zero is a
    // controlled substance and cannot be routinely refilled or renewed by a
    // patient — CII carries no refills at all in law, and CIII-CV renewals need
    // the prescriber contacted rather than a queue item.
    deaClass: (() => {
      const raw = String(r.CLASS ?? "").trim();
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : 0;
    })(),
  };
}

export async function getDrug(kind: DbKind, ndc: string): Promise<PrimeRxDrug | null> {
  const pool = await getMssqlPool(kind);
  const r = (await pool
    .request()
    .input("n", ndc)
    .query(
      `SELECT TOP 1 DRGNDC, DRGNAME, DRGBRNAME, DRGGENNAME, FORM, STRONG, UNITS, CLASS
         FROM DRUG WHERE DRGNDC = @n`,
    )) as { recordset: IRecordSet<DrugRow> };
  const row = r.recordset[0];
  return row ? rowToDrug(row) : null;
}
