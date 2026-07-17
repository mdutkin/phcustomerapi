// PATIENT — primary clinical identity in PrimeRX.
// We surface a thin slice for the portal; pharmacy operations stay in
// PrimeRX itself.

import type { IRecordSet } from "mssql";
import { getMssqlPool } from "@/db/mssql";
import type { DbKind, PrimeRxPatient } from "./types";

const SELECT_COLS = `
  PATIENTNO,
  LNAME,
  FNAME,
  MI,
  DOB,
  SEX,
  EMAIL,
  PHONE,
  MOBILENO,
  ADDRSTR,
  ADDRSTRLINE2,
  ADDRCT,
  ADDRST,
  ADDRZP,
  ACTIVE,
  IS340B,
  primaryins,
  groupno1,
  medno1,
  ALLERGY,
  LANGUAGE
`;

interface PatientRow {
  PATIENTNO: number;
  LNAME: string | null;
  FNAME: string | null;
  MI: string | null;
  DOB: Date | null;
  SEX: string | null;
  EMAIL: string | null;
  PHONE: string | null;
  MOBILENO: string | null;
  ADDRSTR: string | null;
  ADDRSTRLINE2: string | null;
  ADDRCT: string | null;
  ADDRST: string | null;
  ADDRZP: string | null;
  ACTIVE: string | null;
  IS340B: boolean | null;
  primaryins: string | null;
  groupno1: string | null;
  medno1: string | null;
  ALLERGY: string | null;
  LANGUAGE: string | null;
}

function rowToPatient(r: PatientRow): PrimeRxPatient {
  return {
    patientno: r.PATIENTNO,
    lastName: r.LNAME?.trim() || null,
    firstName: r.FNAME?.trim() || null,
    middleInitial: r.MI?.trim() || null,
    dob: r.DOB,
    sex: r.SEX?.trim() || null,
    email: r.EMAIL?.trim() || null,
    phone: r.PHONE?.trim() || null,
    mobile: r.MOBILENO?.trim() || null,
    addressLine1: r.ADDRSTR?.trim() || null,
    addressLine2: r.ADDRSTRLINE2?.trim() || null,
    city: r.ADDRCT?.trim() || null,
    state: r.ADDRST?.trim() || null,
    zip: r.ADDRZP?.trim() || null,
    active: (r.ACTIVE ?? "").trim().toUpperCase() !== "N",
    is340b: !!r.IS340B,
    primaryInsurance: r.primaryins?.trim() || null,
    primaryGroupNo: r.groupno1?.trim() || null,
    primaryMemberNo: r.medno1?.trim() || null,
    allergies: r.ALLERGY?.trim() || null,
    language: r.LANGUAGE?.trim() || null,
  };
}

export async function getPatient(kind: DbKind, patientno: number): Promise<PrimeRxPatient | null> {
  const pool = await getMssqlPool(kind);
  const r = (await pool
    .request()
    .input("p", patientno)
    .query(`SELECT TOP 1 ${SELECT_COLS} FROM PATIENT WHERE PATIENTNO = @p`)) as { recordset: IRecordSet<PatientRow> };
  const row = r.recordset[0];
  return row ? rowToPatient(row) : null;
}

// PrimeRX stores PHONE/MOBILENO as char(10) — bare 10-digit US numbers, no
// country code. Callers pass the last 10 digits of an E.164 number.

/**
 * How many ACTIVE patients share this phone number? Used as a blocklist: the
 * legacy data has placeholder numbers on thousands of records (one PHONE is on
 * 3,265 patients), and such a number proves nothing about identity.
 */
export async function countPatientsByPhone(kind: DbKind, last10: string): Promise<number> {
  const pool = await getMssqlPool(kind);
  const r = (await pool
    .request()
    .input("p", last10)
    .query(
      `SELECT COUNT(*) AS n
         FROM PATIENT
        WHERE ISNULL(ACTIVE, 'Y') <> 'N'
          AND (
                RIGHT(LTRIM(RTRIM(ISNULL(PHONE, ''))), 10) = @p
             OR RIGHT(LTRIM(RTRIM(ISNULL(MOBILENO, ''))), 10) = @p
          )`,
    )) as { recordset: Array<{ n: number }> };
  return r.recordset[0]?.n ?? 0;
}

/**
 * Claim lookup: ACTIVE patients whose on-file PHONE/MOBILENO matches a phone the
 * caller has already PROVEN possession of (Firebase phone sign-in), AND whose
 * last name + DOB match what they typed.
 *
 * The phone is the POSSESSION factor; last name + DOB only confirm which person
 * on that number it is (a household may share a line). Date comparison stays in
 * SQL via CONVERT(date, ...) to avoid JS timezone drift on DOB.
 */
export async function findClaimCandidatesByVerifiedPhone(
  kind: DbKind,
  last10: string,
  lastName: string,
  dob: string, // YYYY-MM-DD
  limit = 5,
): Promise<PrimeRxPatient[]> {
  const pool = await getMssqlPool(kind);
  const r = (await pool
    .request()
    .input("p", last10)
    .input("ln", lastName.trim())
    .input("dob", dob)
    .query(
      `SELECT TOP ${Number(limit)} ${SELECT_COLS}
         FROM PATIENT
        WHERE ISNULL(ACTIVE, 'Y') <> 'N'
          AND UPPER(LTRIM(RTRIM(LNAME))) = UPPER(@ln)
          AND CONVERT(date, DOB) = CONVERT(date, @dob)
          AND (
                RIGHT(LTRIM(RTRIM(ISNULL(PHONE, ''))), 10) = @p
             OR RIGHT(LTRIM(RTRIM(ISNULL(MOBILENO, ''))), 10) = @p
          )`,
    )) as { recordset: IRecordSet<PatientRow> };
  return r.recordset.map(rowToPatient);
}

export interface PatientSearchInput {
  lastName: string;
  dob: string;        // YYYY-MM-DD
  phoneLast4: string; // last 4 digits of phone or mobile
}

/**
 * Self-claim search: find a patient whose last name matches AND DOB
 * matches AND last 4 digits of either PHONE or MOBILENO match. We
 * intentionally require all three signals — no two of three.
 *
 * Returns at most one match per DB; caller probes both DBs.
 */
export async function searchPatientForClaim(
  kind: DbKind,
  input: PatientSearchInput,
): Promise<PrimeRxPatient | null> {
  const pool = await getMssqlPool(kind);
  const last4 = input.phoneLast4.replace(/\D/g, "").slice(-4);
  if (last4.length !== 4) return null;

  const r = (await pool
    .request()
    .input("ln", input.lastName.trim())
    .input("dob", input.dob)
    .input("last4", last4)
    .query(
      `SELECT TOP 2 ${SELECT_COLS}
         FROM PATIENT
        WHERE UPPER(LTRIM(RTRIM(LNAME))) = UPPER(@ln)
          AND CONVERT(date, DOB) = CONVERT(date, @dob)
          AND (
                RIGHT(LTRIM(RTRIM(ISNULL(PHONE, ''))), 4) = @last4
             OR RIGHT(LTRIM(RTRIM(ISNULL(MOBILENO, ''))), 4) = @last4
          )`,
    )) as { recordset: IRecordSet<PatientRow> };

  // Ambiguous match (multiple PATIENTNOs satisfy criteria) → refuse.
  // Self-claim must be unique; pharmacy admin can resolve manually.
  if (r.recordset.length !== 1) return null;
  const first = r.recordset[0];
  if (!first) return null;
  return rowToPatient(first);
}
