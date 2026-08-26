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
  PICKUPFROM: string | null;
  PICKUPTIME: string | null;
  FiledDeferredReasonID: number | null;
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

// PrimeRX records the handover on the fill itself. The Track Rx audit shows the
// lifecycle: DELIVERY is set to 'D' when the fill joins a delivery run, then
// flips to 'Y' at the same moment PICKEDUP goes N->Y and PICKUPFROM becomes
// 'DEL'. A billed fill that is neither collected nor on a run is sitting on the
// shelf waiting — PrimeRX's own Live Workflow panel counts exactly that as
// "Rx(s) Ready".
//
// IMPORTANT: PICKEDUP is only reliably populated on recent records (~1.99M
// historical CLAIMS rows have it NULL), so "waiting" is bounded by fill date.
// Without that bound every ancient claim would look like it was ready for
// collection. PrimeRX bounds its own panel with a From: date for the same reason.
const READY_WINDOW_DAYS = 30;

function handoffOf(r: {
  PICKEDUP: string | null;
  PICKUPFROM: string | null;
  DELIVERY: string | null;
  STATUS: string | null;
  DATEF: Date | null;
}): "delivered" | "picked_up" | "awaiting_delivery" | "ready_for_pickup" | null {
  const from = (r.PICKUPFROM ?? "").trim().toUpperCase();
  const del = (r.DELIVERY ?? "").trim().toUpperCase();
  if ((r.PICKEDUP ?? "").trim().toUpperCase() === "Y") {
    if (from === "DEL" || ["Y", "D", "S"].includes(del)) return "delivered";
    return "picked_up";
  }
  // Not handed over yet.
  if (del === "D") return "awaiting_delivery";
  const billed = (r.STATUS ?? "").trim().toUpperCase() === "B";
  const filled = r.DATEF ? r.DATEF.getTime() : null;
  const recent =
    filled !== null && Date.now() - filled <= READY_WINDOW_DAYS * 86_400_000;
  if (billed && recent) return "ready_for_pickup";
  return null;
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
    // SIG is often a pharmacist shorthand code ("T1TPOQD"); SIGLINES carries the
    // expansion PrimeRX shows on screen ("TAKE 1 TABLET BY MOUTH DAILY"), and is
    // populated on all but 16 of 2.2M rows. Patients get the readable one.
    sig: r.SIGLINES?.trim() || r.SIG?.trim() || null,
    sigLines: r.SIGLINES?.trim() || null,
    pickedUp: (r.PICKEDUP ?? "").trim().toUpperCase() === "Y",
    pickupDate: r.PICKUPDATE,
    handoff: handoffOf(r),
    pickupTime: r.PICKUPTIME?.trim() || null,
    filedReasonId: r.FiledDeferredReasonID ?? null,
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
  PICKEDUP, PICKUPDATE, PICKUPTIME, PICKUPFROM, FiledDeferredReasonID,
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


// ─── Filed/Deferred reasons ─────────────────────────────────────────────────
//
// STATUS='F' means the prescription is ON FILE but was never dispensed — the
// pharmacy parked it. FiledDeferredReason explains why (PA REQD, REFILL TOO
// SOON, PT REJECTED, ...). It's a tiny static lookup, so cache it per database
// rather than joining it onto every claim query.

const reasonCache = new Map<DbKind, Map<number, string>>();

export async function getFiledDeferredReasons(kind: DbKind): Promise<Map<number, string>> {
  const cached = reasonCache.get(kind);
  if (cached) return cached;
  const pool = await getMssqlPool(kind);
  const r = (await pool
    .request()
    .query("SELECT FiledDeferredReasonID, Name FROM FiledDeferredReason")) as {
    recordset: Array<{ FiledDeferredReasonID: number; Name: string | null }>;
  };
  const map = new Map<number, string>();
  for (const row of r.recordset) {
    if (row.Name) map.set(row.FiledDeferredReasonID, row.Name.trim());
  }
  reasonCache.set(kind, map);
  return map;
}


// ─── Delivery ───────────────────────────────────────────────────────────────
//
// Deliveries live in their own subsystem (DELIVERY_ORDER + DELIVERY_DETAIL).
// NOTE: DELIVERY_ORDER.DelStatus is NOT a reliable "was it delivered" signal —
// staff frequently leave orders open ('O') with a null DateDelivered even after
// the driver has been. CLAIMS.PICKEDUP/PICKUPDATE is the source of truth for
// that; this table is what tells us WHERE it went, WHEN it was requested and
// WHO drove it.

export interface PrimeRxDelivery {
  orderId: number;
  address: string | null;
  instructions: string | null;
  requestedDate: Date | null;
  deliveredDate: Date | null;
  driver: string | null;
  acceptedBy: string | null;
  trackingNo: string | null;
}

export interface PrimeRxFillDelivery extends PrimeRxDelivery {
  refillNo: number;
}

/**
 * Deliveries for every fill of an Rx, keyed by refill number.
 *
 * A prescription is NOT delivered to one fixed place: refills routinely go to
 * different addresses (one Rx in this data has six refills across five
 * addresses, and patients carry up to eight). So the address belongs to the
 * FILL, never to the prescription — callers must match on refill number rather
 * than taking "the" address for an Rx.
 */
// DELIVERY_ORDER.DRIVER holds an internal code ("AM"); DELIVERY_USER maps it to
// a person ("JASMIN"). Showing patients the code is meaningless, so resolve it.
// Tiny static table — cache per database.
const driverCache = new Map<DbKind, Map<string, string>>();

async function getDriverNames(kind: DbKind): Promise<Map<string, string>> {
  const cached = driverCache.get(kind);
  if (cached) return cached;
  const pool = await getMssqlPool(kind);
  const r = (await pool
    .request()
    .query("SELECT UserId, UserName FROM DELIVERY_USER")) as {
    recordset: Array<{ UserId: string | null; UserName: string | null }>;
  };
  const map = new Map<string, string>();
  for (const row of r.recordset) {
    const id = (row.UserId ?? "").trim().toUpperCase();
    const name = (row.UserName ?? "").trim();
    // Skip the pharmacy's own account — it isn't a person delivering.
    if (id && name && name.toUpperCase() !== "MEDICO PHARMACY") map.set(id, name);
  }
  driverCache.set(kind, map);
  return map;
}

export async function getDeliveriesForRx(
  kind: DbKind,
  rxno: string,
): Promise<Map<number, PrimeRxFillDelivery>> {
  const pool = await getMssqlPool(kind);
  const r = (await pool
    .request()
    .input("rx", rxno)
    .query(
      `SELECT d.RefillNo,
              o.DelPatRecId, o.PATIENTADDRESS, o.DelInstructions, o.ReqDelDate,
              ISNULL(d.DateDelivered, o.DateDelivered) AS DateDelivered,
              o.DRIVER, o.DelAcceptedBy, o.Ship_TrackingNo
         FROM DELIVERY_DETAIL d
         JOIN DELIVERY_ORDER o ON o.DelPatRecId = d.DelPatRecId
        WHERE d.RxNo = @rx
        ORDER BY d.RefillNo ASC, ISNULL(d.DateDelivered, o.ReqDelDate) ASC`,
    )) as {
    recordset: Array<{
      RefillNo: number | string | null;
      DelPatRecId: number;
      PATIENTADDRESS: string | null;
      DelInstructions: string | null;
      ReqDelDate: Date | null;
      DateDelivered: Date | null;
      DRIVER: string | null;
      DelAcceptedBy: string | null;
      Ship_TrackingNo: string | null;
    }>;
  };

  const clean = (v: string | null) => {
    const t = (v ?? "").trim();
    return t.length > 0 ? t : null;
  };

  const drivers = await getDriverNames(kind);
  const byRefill = new Map<number, PrimeRxFillDelivery>();
  for (const row of r.recordset) {
    const refillNo = Number(row.RefillNo ?? 0);
    if (Number.isNaN(refillNo)) continue;
    // Ordered ascending by date, so a later row for the same refill is the
    // more recent attempt and should win.
    byRefill.set(refillNo, {
      refillNo,
      orderId: row.DelPatRecId,
      // Stored as "STREET,,CITY,ST,ZIP" — tidy the doubled/edge commas.
      address:
        clean(row.PATIENTADDRESS)
          ?.replace(/\s*,\s*/g, ", ")
          .replace(/(,\s*)+/g, ", ")
          .replace(/^,\s*|,\s*$/g, "") ?? null,
      instructions: clean(row.DelInstructions),
      requestedDate: row.ReqDelDate,
      deliveredDate: row.DateDelivered,
      driver: (() => {
        const code = clean(row.DRIVER);
        if (!code) return null;
        return drivers.get(code.toUpperCase()) ?? code;
      })(),
      acceptedBy: clean(row.DelAcceptedBy),
      trackingNo: clean(row.Ship_TrackingNo),
    });
  }
  return byRefill;
}


// ─── Renewal requests to the prescriber ─────────────────────────────────────
//
// When an Rx runs out of refills the pharmacy sends the prescriber a REFREQ
// (PrimeRX's "ERx Action List"; blank TRANSSTAT = "Awaiting Response"). Telling
// the patient "we've already asked your doctor" is the missing half of the
// no-refills-left story.
//
// ⚠️ TRANSSTAT is only closed out when staff action the row, so OLD blank rows
// are stale, not pending: our test patient has REFREQs from January and March
// still marked blank even though both were renewed into new Rx numbers. PrimeRX
// works around this by filtering its own screen to recently-received messages —
// we bound the window for the same reason. Showing a months-old "awaiting" would
// be actively misleading.
const RENEWAL_PENDING_DAYS = 45;

export interface PendingRenewal {
  rxno: string;
  sentAt: Date;
  prescriberName: string | null;
}

export async function getPendingRenewals(
  kind: DbKind,
  patientno: number,
): Promise<Map<string, PendingRenewal>> {
  const pool = await getMssqlPool(kind);
  const r = (await pool
    .request()
    .input("p", patientno)
    .input("days", RENEWAL_PENDING_DAYS)
    .query(
      `SELECT RXNO, SENTDTTIME, PRSFNAME, PRSLNAME
         FROM EREQUEST
        WHERE PATIENTNO = @p
          AND LTRIM(RTRIM(ISNULL(MSGTYPE, ''))) = 'REFREQ'
          AND LTRIM(RTRIM(ISNULL(TRANSSTAT, ''))) = ''
          AND SENTDTTIME >= DATEADD(day, -@days, GETDATE())
        ORDER BY SENTDTTIME DESC`,
    )) as {
    recordset: Array<{
      RXNO: string | null;
      SENTDTTIME: Date | null;
      PRSFNAME: string | null;
      PRSLNAME: string | null;
    }>;
  };
  const out = new Map<string, PendingRenewal>();
  for (const row of r.recordset) {
    const rxno = (row.RXNO ?? "").trim();
    if (!rxno || !row.SENTDTTIME || out.has(rxno)) continue;
    const name = [row.PRSFNAME, row.PRSLNAME].map((x) => (x ?? "").trim()).filter(Boolean).join(" ");
    out.set(rxno, { rxno, sentAt: row.SENTDTTIME, prescriberName: name || null });
  }
  return out;
}


// ─── Refill due dates (the pharmacy's own calculation) ──────────────────────
//
// `RefDueView` is PrimeRX's authoritative "when is this due for a refill" view —
// the same numbers staff see. It accounts for quantity remaining and pickup-based
// thresholds, which a naive lastFilled + daysSupply does not, so deriving our own
// invites the patient and the pharmacy disagreeing about a date.
//
// DaysRemaining is SIGNED: negative means the patient has already run out and is
// that many days overdue. Our own calculation clamps at zero, which throws away
// the single most useful adherence signal we have.
//
// Only prescriptions the pharmacy is tracking appear here, so treat it as
// supplementary — never assume every Rx has a row. The view costs ~800ms, so
// callers should run it alongside their other queries, not in series.

export interface RefillDue {
  rxno: string;
  dueDate: Date | null;
  daysRemaining: number | null;
  qtyRemaining: number | null;
}

export async function getRefillDueInfo(
  kind: DbKind,
  patientno: number,
): Promise<Map<string, RefillDue>> {
  const pool = await getMssqlPool(kind);
  const r = (await pool
    .request()
    .input("p", patientno)
    .query(
      `SELECT RXNO, Duedate, DaysRemaining, QtyRemaining
         FROM RefDueView
        WHERE PATIENTNO = @p`,
    )) as {
    recordset: Array<{
      RXNO: string | null;
      Duedate: Date | null;
      DaysRemaining: number | null;
      QtyRemaining: number | null;
    }>;
  };
  const out = new Map<string, RefillDue>();
  for (const row of r.recordset) {
    const rxno = (row.RXNO ?? "").trim();
    if (!rxno) continue;
    out.set(rxno, {
      rxno,
      dueDate: row.Duedate ?? null,
      daysRemaining: row.DaysRemaining ?? null,
      qtyRemaining: row.QtyRemaining ?? null,
    });
  }
  return out;
}
