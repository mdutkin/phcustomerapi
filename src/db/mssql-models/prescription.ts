// CLAIMS — one row per fill cycle (RXNO + NREFILL is the natural key).
//
// The portal "prescriptions" view is built from CLAIMS joined with DRUG
// and PRESCRIB for display. We collapse fills by RXNO and surface the
// most recent fill row per Rx. Refill availability is derived from
// (TREFILLS - max(NREFILL filled)).

import type { IRecordSet } from "mssql";
import { getMssqlPool } from "@/db/mssql";
import type { DbKind, PrimeRxClaim } from "./types";

interface ClaimRow {
  RXNO: string | number; // bigint — mssql may return as string/number
  NREFILL: number;
  TREFILLS: number | null;
  PATIENTNO: number;
  PRESNO: number | null;
  NDC: string | null;
  DRGNAME: string | null;
  STATUS: string | null;
  DATEO: Date | null;
  DATEF: Date | null;
  DAYS: string | null;
  QTY_ORD: string | number | null;
  QUANT: string | number | null;
  SIG: string | null;
  SIGLINES: string | null;
  PICKEDUP: string | null;
  PICKUPDATE: Date | null;
  TOTAMT: string | number | null;
  COPAY: string | number | null;
  IS340B: boolean | null;
  DELIVERY: string | null;
}

function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function moneyStr(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

function rowToClaim(r: ClaimRow): PrimeRxClaim {
  return {
    rxno: String(r.RXNO),
    refillNo: r.NREFILL ?? 0,
    totalRefills: r.TREFILLS ?? 0,
    patientno: r.PATIENTNO,
    presno: r.PRESNO,
    ndc: r.NDC?.trim() || null,
    drgname: r.DRGNAME?.trim() || null,
    status: r.STATUS?.trim() || null,
    dateWritten: r.DATEO,
    dateFilled: r.DATEF,
    daysSupply: r.DAYS ? Number(r.DAYS) : null,
    qtyOrdered: num(r.QTY_ORD),
    qtyDispensed: num(r.QUANT),
    sig: r.SIG?.trim() || null,
    sigLines: r.SIGLINES?.trim() || null,
    pickedUp: (r.PICKEDUP ?? "").trim().toUpperCase() === "Y",
    pickupDate: r.PICKUPDATE,
    totalAmount: moneyStr(r.TOTAMT),
    copay: moneyStr(r.COPAY),
    is340b: !!r.IS340B,
    delivery: (r.DELIVERY ?? "").trim().toUpperCase() === "Y",
  };
}

const SELECT_COLS = `
  RXNO, NREFILL, TREFILLS, PATIENTNO, PRESNO,
  NDC, DRGNAME, STATUS,
  DATEO, DATEF, DAYS, QTY_ORD, QUANT,
  SIG, SIGLINES,
  PICKEDUP, PICKUPDATE,
  TOTAMT, COPAY, IS340B, DELIVERY
`;

/**
 * List active prescriptions for a patient — one row per RXNO (latest
 * fill cycle). Caller can join DRUG / PRESCRIB for display.
 */
export async function listPrescriptionsForPatient(
  kind: DbKind,
  patientno: number,
  opts: { limit?: number } = {},
): Promise<PrimeRxClaim[]> {
  const limit = opts.limit ?? 200;
  const pool = await getMssqlPool(kind);
  const r = (await pool
    .request()
    .input("p", patientno)
    .input("lim", limit)
    .query(
      `WITH latest AS (
         SELECT ${SELECT_COLS},
                ROW_NUMBER() OVER (PARTITION BY RXNO ORDER BY NREFILL DESC) AS rn
           FROM CLAIMS
          WHERE PATIENTNO = @p
       )
       SELECT TOP (@lim) ${SELECT_COLS}
         FROM latest
        WHERE rn = 1
        ORDER BY DATEF DESC, DATEO DESC`,
    )) as { recordset: IRecordSet<ClaimRow> };
  return r.recordset.map(rowToClaim);
}

/**
 * Fetch a single Rx by RXNO. Returns the most recent fill cycle.
 * Scoped to patientno to prevent cross-patient probing.
 */
export async function getPrescription(
  kind: DbKind,
  patientno: number,
  rxno: string,
): Promise<PrimeRxClaim | null> {
  const pool = await getMssqlPool(kind);
  const r = (await pool
    .request()
    .input("p", patientno)
    .input("rx", rxno)
    .query(
      `SELECT TOP 1 ${SELECT_COLS}
         FROM CLAIMS
        WHERE PATIENTNO = @p AND RXNO = @rx
        ORDER BY NREFILL DESC`,
    )) as { recordset: IRecordSet<ClaimRow> };
  const row = r.recordset[0];
  return row ? rowToClaim(row) : null;
}

/**
 * Fill history for a single Rx — every NREFILL row, oldest first.
 */
export async function getPrescriptionHistory(
  kind: DbKind,
  patientno: number,
  rxno: string,
): Promise<PrimeRxClaim[]> {
  const pool = await getMssqlPool(kind);
  const r = (await pool
    .request()
    .input("p", patientno)
    .input("rx", rxno)
    .query(
      `SELECT ${SELECT_COLS}
         FROM CLAIMS
        WHERE PATIENTNO = @p AND RXNO = @rx
        ORDER BY NREFILL ASC`,
    )) as { recordset: IRecordSet<ClaimRow> };
  return r.recordset.map(rowToClaim);
}
