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
  };
}

export async function getDrug(kind: DbKind, ndc: string): Promise<PrimeRxDrug | null> {
  const pool = await getMssqlPool(kind);
  const r = (await pool
    .request()
    .input("n", ndc)
    .query(
      `SELECT TOP 1 DRGNDC, DRGNAME, DRGBRNAME, DRGGENNAME, FORM, STRONG, UNITS
         FROM DRUG WHERE DRGNDC = @n`,
    )) as { recordset: IRecordSet<DrugRow> };
  const row = r.recordset[0];
  return row ? rowToDrug(row) : null;
}
