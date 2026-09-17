// Staff work list — "who is due for a refill, and are we already allowed to
// fill it?" — read from PrimeRX for ONE database. The service layer runs it
// for both databases and merges people across them.
//
// Sources (all read-only, all decoded in .planning/primerx-data-map.md):
// - RefDueView            the pharmacy's own due/eligibility verdict
//                          (RefillStatusThreshold = 'OKTOREFILL', threshold applied)
// - PATIENT               name, DOB, numbers, language, active
// - DRUG.CLASS            DEA schedule (controlled needs prescriber contact when
//                          no refills left — but a refill with refills left is fine)
// - Patient_Consent /     live per-Rx "Prescription Auto Refill Consent = Yes" —
//   Patient_PrescriptionConsent   the written authorisation to fill without a call
// - CLAIMS (latest fill)  delivery vs pickup, so staff know how it will go out
// - RXREFQUE (<90d)       already sitting in PrimeRX's own refill queue
//
// Bounded to medication filled in the last 180 days: RefDueView keeps tracking
// superseded Rx numbers forever, and "ran out 230 days ago" of a drug the patient
// now takes under a newer Rx is noise, not work.

import { getMssqlPool, type MssqlKind } from "../mssql";

export interface WorklistRxRow {
  patientno: number;
  lastName: string | null;
  firstName: string | null;
  dob: Date | null;
  phone: string | null;
  mobile: string | null;
  languageNo: number | null;
  rxno: string;
  drugName: string | null;
  drugStrength: string | null;
  deaClass: number;
  lastFilledAt: Date | null;
  daysSupply: number | null;
  refillsRemaining: number;
  daysRemaining: number | null;
  dueDate: Date | null;
  consentUntil: Date | null;
  /** 'delivery' when the last fill went out with a driver, else 'pickup'. */
  handoff: "delivery" | "pickup";
  inPrimeRxQueueSince: Date | null;
}

const SQL = `
WITH due AS (
  SELECT v.PATIENTNO, RTRIM(v.RXNO) AS RXNO, v.DrugName, v.DRGNDC,
         v.lastDateFilled, v.lastDaysSupply, v.NREFILL, v.TREFILLS,
         v.DaysRemaining, v.Duedate
    FROM RefDueView v
   WHERE RTRIM(v.RefillStatusThreshold) = 'OKTOREFILL'
     AND v.IsLatestEq = 1
     AND v.lastDateFilled >= DATEADD(DAY, -180, GETDATE())
),
consent AS (
  SELECT RTRIM(ppc.RxNo) AS RXNO, MAX(pc.ConsentEndDate) AS ConsentUntil
    FROM Patient_PrescriptionConsent ppc
    JOIN Patient_Consent pc ON pc.ID = ppc.PatientConsentID
   WHERE ppc.ConsentStatusID = 9 AND pc.ConsentStatusID = 9
     AND ppc.ReplacedByRxNo IS NULL
     AND (pc.ConsentEndDate IS NULL OR pc.ConsentEndDate >= GETDATE())
   GROUP BY RTRIM(ppc.RxNo)
),
lastfill AS (
  SELECT c.RXNO, c.DELIVERY, c.PICKUPFROM,
         ROW_NUMBER() OVER (PARTITION BY c.RXNO ORDER BY c.NREFILL DESC) AS rn
    FROM CLAIMS c
),
queued AS (
  SELECT RTRIM(q.RXNO) AS RXNO, MIN(q.DATE_QUED) AS QueuedSince
    FROM RXREFQUE q
   WHERE q.DATE_QUED >= DATEADD(DAY, -90, GETDATE())
   GROUP BY RTRIM(q.RXNO)
)
SELECT d.PATIENTNO, p.LNAME, p.FNAME, p.DOB, p.PHONE, p.MOBILENO, p.LANGUAGE,
       d.RXNO, d.DrugName, drg.STRONG, drg.CLASS,
       d.lastDateFilled, d.lastDaysSupply, d.NREFILL, d.TREFILLS,
       d.DaysRemaining, d.Duedate,
       cs.ConsentUntil,
       lf.DELIVERY, lf.PICKUPFROM,
       qd.QueuedSince
  FROM due d
  JOIN PATIENT p ON p.PATIENTNO = d.PATIENTNO
  LEFT JOIN DRUG drg ON drg.DRGNDC = d.DRGNDC
  LEFT JOIN consent cs ON cs.RXNO = d.RXNO
  LEFT JOIN lastfill lf ON lf.RXNO = d.RXNO AND lf.rn = 1
  LEFT JOIN queued qd ON qd.RXNO = d.RXNO
 WHERE ISNULL(p.ACTIVE, 'Y') <> 'N'
   AND ISNULL(CAST(p.DECEASED AS VARCHAR(5)), '0') NOT IN ('1', 'Y', 'True')
`;

interface Row {
  PATIENTNO: number;
  LNAME: string | null;
  FNAME: string | null;
  DOB: Date | null;
  PHONE: string | null;
  MOBILENO: string | null;
  LANGUAGE: string | null;
  RXNO: string;
  DrugName: string | null;
  STRONG: string | null;
  CLASS: string | null;
  lastDateFilled: Date | null;
  lastDaysSupply: number | null;
  NREFILL: number | null;
  TREFILLS: number | null;
  DaysRemaining: number | null;
  Duedate: Date | null;
  ConsentUntil: Date | null;
  DELIVERY: string | null;
  PICKUPFROM: string | null;
  QueuedSince: Date | null;
}

const clean = (s: string | null | undefined) => {
  const t = (s ?? "").trim();
  return t.length ? t : null;
};
const tenDigits = (s: string | null | undefined) => {
  const d = (s ?? "").replace(/\D/g, "");
  return d.length === 10 ? d : null;
};

export async function getWorklist(kind: MssqlKind): Promise<WorklistRxRow[]> {
  const pool = await getMssqlPool(kind);
  const r = (await pool.request().query(SQL)) as { recordset: Row[] };
  return r.recordset.map((x) => {
    const deliveryFlag = clean(x.DELIVERY)?.toUpperCase();
    const from = clean(x.PICKUPFROM)?.toUpperCase();
    const handoff: WorklistRxRow["handoff"] =
      deliveryFlag === "D" || deliveryFlag === "Y" || from === "DEL" ? "delivery" : "pickup";
    const total = x.TREFILLS ?? 0;
    const used = x.NREFILL ?? 0;
    return {
      patientno: x.PATIENTNO,
      lastName: clean(x.LNAME),
      firstName: clean(x.FNAME),
      dob: x.DOB ?? null,
      phone: tenDigits(x.PHONE),
      mobile: tenDigits(x.MOBILENO),
      languageNo: x.LANGUAGE && /^\d+$/.test(x.LANGUAGE.trim()) ? Number(x.LANGUAGE) : null,
      rxno: x.RXNO,
      drugName: clean(x.DrugName),
      drugStrength: clean(x.STRONG),
      deaClass: Number((x.CLASS ?? "0").trim()) || 0,
      lastFilledAt: x.lastDateFilled ?? null,
      daysSupply: x.lastDaysSupply ?? null,
      refillsRemaining: Math.max(0, total - used),
      daysRemaining: x.DaysRemaining ?? null,
      dueDate: x.Duedate ?? null,
      consentUntil: x.ConsentUntil ?? null,
      handoff,
      inPrimeRxQueueSince: x.QueuedSince ?? null,
    };
  });
}
