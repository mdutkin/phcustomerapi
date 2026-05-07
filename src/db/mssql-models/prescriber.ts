// PRESCRIB — prescriber lookup.

import type { IRecordSet } from "mssql";
import { getMssqlPool } from "@/db/mssql";
import type { DbKind, PrimeRxPrescriber } from "./types";

interface PrescriberRow {
  PRESNO: number;
  PRESLNM: string | null;
  PRESFNM: string | null;
  PRESMNM: string | null;
  NPINO: string | null;
  PRESDEA: string | null;
  PHONE: string | null;
  MOBILENO: string | null;
  FAXNO: string | null;
  EMAIL: string | null;
  ADDRSTR: string | null;
  Addrstr2: string | null;
  ADDRCT: string | null;
  ADDRST: string | null;
  ADDRZP: string | null;
  ACTIVE: string | null;
}

function rowToPrescriber(r: PrescriberRow): PrimeRxPrescriber {
  return {
    presno: r.PRESNO,
    lastName: r.PRESLNM?.trim() || null,
    firstName: r.PRESFNM?.trim() || null,
    middleName: r.PRESMNM?.trim() || null,
    npi: r.NPINO?.trim() || null,
    dea: r.PRESDEA?.trim() || null,
    phone: r.PHONE?.trim() || null,
    mobile: r.MOBILENO?.trim() || null,
    fax: r.FAXNO?.trim() || null,
    email: r.EMAIL?.trim() || null,
    addressLine1: r.ADDRSTR?.trim() || null,
    addressLine2: r.Addrstr2?.trim() || null,
    city: r.ADDRCT?.trim() || null,
    state: r.ADDRST?.trim() || null,
    zip: r.ADDRZP?.trim() || null,
    active: (r.ACTIVE ?? "").trim().toUpperCase() !== "N",
  };
}

export async function getPrescriber(kind: DbKind, presno: number): Promise<PrimeRxPrescriber | null> {
  const pool = await getMssqlPool(kind);
  const r = (await pool
    .request()
    .input("p", presno)
    .query(
      `SELECT TOP 1 PRESNO, PRESLNM, PRESFNM, PRESMNM, NPINO, PRESDEA,
                    PHONE, MOBILENO, FAXNO, EMAIL,
                    ADDRSTR, Addrstr2, ADDRCT, ADDRST, ADDRZP, ACTIVE
         FROM PRESCRIB WHERE PRESNO = @p`,
    )) as { recordset: IRecordSet<PrescriberRow> };
  const row = r.recordset[0];
  return row ? rowToPrescriber(row) : null;
}
