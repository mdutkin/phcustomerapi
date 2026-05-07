// INSCAR — insurance carrier lookup. PrimeRX uses IC_CODE as the PK.

import type { IRecordSet } from "mssql";
import { getMssqlPool } from "@/db/mssql";
import type { DbKind, PrimeRxInsurance } from "./types";

interface InsuranceRow {
  IC_CODE: string;
  IC_NAME: string | null;
  BIN_NO: string | null;
  PAYORID: string | null;
  COPAY: string | number | null;
  NOTES: string | null;
}

export async function getInsurance(kind: DbKind, icCode: string): Promise<PrimeRxInsurance | null> {
  const pool = await getMssqlPool(kind);
  const r = (await pool
    .request()
    .input("c", icCode)
    .query(
      `SELECT TOP 1 IC_CODE, IC_NAME, BIN_NO, PAYORID, COPAY, NOTES
         FROM INSCAR WHERE IC_CODE = @c`,
    )) as { recordset: IRecordSet<InsuranceRow> };
  const row = r.recordset[0];
  if (!row) return null;
  return {
    icCode: row.IC_CODE.trim(),
    name: row.IC_NAME?.trim() || null,
    binNo: row.BIN_NO?.trim() || null,
    payorId: row.PAYORID?.trim() || null,
    copay: row.COPAY === null || row.COPAY === undefined ? null : String(row.COPAY),
    notes: row.NOTES?.trim() || null,
  };
}
