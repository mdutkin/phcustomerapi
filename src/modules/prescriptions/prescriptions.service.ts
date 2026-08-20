// Prescription read service.
//
// Reads come from MSSQL (PrimeRX is the system of record). Refill requests are
// enqueued into the unified `command_queue` in PG; a pharmacist performs the
// refill in the PrimeRX client, and the resulting CLAIMS row updates
// downstream. We never write to MSSQL from here.

import {
  getDeliveriesForRx,
  getFiledDeferredReasons,
  getDrug,
  getPrescriber,
  getPrescription,
  getPrescriptionHistory,
  listPrescriptionsForPatient,
} from "@/db/mssql-models";
import type { DbKind, PrimeRxClaim, PrimeRxDrug, PrimeRxPrescriber } from "@/db/mssql-models";
import { enqueueCommand, findOpenCommand } from "@/modules/requests/requests.service";
import { HttpError } from "@/plugins/error-handler";

export interface RxListItem {
  rxno: string;
  dbKind: DbKind;
  drugName: string | null;
  drugStrength: string | null;
  drugForm: string | null;
  ndc: string | null;
  sig: string | null;
  daysSupply: number | null;
  qtyOrdered: number | null;
  refillsRemaining: number;
  refillsTotal: number;
  status: string | null;
  lastFilledAt: string | null;   // ISO date
  pickedUp: boolean;
  pickupDate: string | null;
  handoff: "delivered" | "picked_up" | "awaiting_delivery" | null;
  /** Time of day PrimeRX recorded for the pickup/delivery, when present. */
  pickupTime: string | null;
  /** False when PrimeRX filed/deferred this fill instead of dispensing it. */
  dispensed: boolean;
  /** Why it was filed/deferred, when the pharmacy recorded a reason. */
  filedReason: string | null;
  is340b: boolean;
}

function claimToListItem(
  c: PrimeRxClaim,
  kind: DbKind,
  drug: PrimeRxDrug | null,
  reasons?: Map<number, string>,
): RxListItem {
  return {
    rxno: c.rxno,
    dbKind: kind,
    drugName: drug?.name ?? c.drgname,
    drugStrength: drug?.strength ?? null,
    drugForm: drug?.form ?? null,
    ndc: c.ndc,
    sig: c.sig,
    daysSupply: c.daysSupply,
    qtyOrdered: c.qtyOrdered,
    refillsRemaining: Math.max(0, c.totalRefills - c.refillNo),
    refillsTotal: c.totalRefills,
    status: c.status,
    lastFilledAt: c.dateFilled ? c.dateFilled.toISOString().slice(0, 10) : null,
    pickedUp: c.pickedUp,
    pickupDate: c.pickupDate ? c.pickupDate.toISOString() : null,
    handoff: c.handoff,
    pickupTime: c.pickupTime,
    // 'F' = filed/deferred: on file, never handed to the patient.
    dispensed: (c.status ?? "").trim().toUpperCase() !== "F",
    filedReason:
      c.filedReasonId != null ? (reasons?.get(c.filedReasonId) ?? null) : null,
    is340b: c.is340b,
  };
}

export async function listPrescriptions(kind: DbKind, patientno: number): Promise<RxListItem[]> {
  const claims = await listPrescriptionsForPatient(kind, patientno);
  // Hydrate drugs in parallel — most patients have a handful of distinct
  // NDCs, so a per-row fetch is fine for now. Optimise to batch SELECT
  // IN (...) when this list grows.
  const [drugs, reasons] = await Promise.all([
    Promise.all(claims.map((c) => (c.ndc ? getDrug(kind, c.ndc) : Promise.resolve(null)))),
    getFiledDeferredReasons(kind),
  ]);
  return claims.map((c, i) => claimToListItem(c, kind, drugs[i] ?? null, reasons));
}

export interface PatientLink {
  dbKind: DbKind;
  patientno: number;
}

/**
 * Prescriptions across EVERY database the user is linked to. A patient present
 * in both PrimeRX DBs may have all their Rx in one of them (e.g. nothing in
 * 340B, everything in Conventional), so reading only the primary link silently
 * shows an empty list. Newest fill first.
 */
export async function listPrescriptionsAcross(links: PatientLink[]): Promise<RxListItem[]> {
  const perDb = await Promise.all(links.map((l) => listPrescriptions(l.dbKind, l.patientno)));
  return perDb.flat().sort((a, b) => (b.lastFilledAt ?? "").localeCompare(a.lastFilledAt ?? ""));
}

/**
 * Which linked record actually holds this RXNO. RXNO is only unique within a
 * database, so detail/refill routes must resolve it before querying.
 */
export async function resolveRxLink(
  links: PatientLink[],
  rxno: string,
): Promise<PatientLink> {
  for (const l of links) {
    const claim = await getPrescription(l.dbKind, l.patientno, rxno);
    if (claim) return l;
  }
  throw new HttpError(404, "prescription_not_found");
}

export interface DeliveryInfo {
  address: string | null;
  instructions: string | null;
  requestedDate: string | null;
  deliveredDate: string | null;
  driver: string | null;
  trackingNo: string | null;
}

function toDeliveryInfo(d: {
  address: string | null;
  instructions: string | null;
  requestedDate: Date | null;
  deliveredDate: Date | null;
  driver: string | null;
  trackingNo: string | null;
} | undefined): DeliveryInfo | null {
  if (!d) return null;
  return {
    address: d.address,
    instructions: d.instructions,
    requestedDate: d.requestedDate ? d.requestedDate.toISOString() : null,
    deliveredDate: d.deliveredDate ? d.deliveredDate.toISOString() : null,
    driver: d.driver,
    trackingNo: d.trackingNo,
  };
}

export interface RxDetail {
  rx: RxListItem;
  /**
   * Delivery for the CURRENT (latest) fill only. Refills can each go somewhere
   * different, so this is not "the address for this prescription" — per-fill
   * addresses live on `history`.
   */
  delivery: DeliveryInfo | null;
  prescriber: PrimeRxPrescriber | null;
  history: Array<{
    refillNo: number;
    filledAt: string | null;
    qtyDispensed: number | null;
    pickedUp: boolean;
    pickupDate: string | null;
    handoff: "delivered" | "picked_up" | "awaiting_delivery" | null;
    pickupTime: string | null;
    dispensed: boolean;
    filedReason: string | null;
    /** Where THIS fill went, when it was delivered. */
    delivery: DeliveryInfo | null;
  }>;
  pendingRefillRequest: {
    id: string;
    status: string;
    requestedAt: string;
  } | null;
}

export async function getPrescriptionDetail(
  userId: string,
  kind: DbKind,
  patientno: number,
  rxno: string,
): Promise<RxDetail> {
  const claim = await getPrescription(kind, patientno, rxno);
  if (!claim) throw new HttpError(404, "prescription_not_found");

  const [drug, prescriber, history, reasons, delivery] = await Promise.all([
    claim.ndc ? getDrug(kind, claim.ndc) : Promise.resolve(null),
    claim.presno !== null ? getPrescriber(kind, claim.presno) : Promise.resolve(null),
    getPrescriptionHistory(kind, patientno, rxno),
    getFiledDeferredReasons(kind),
    getDeliveriesForRx(kind, rxno),
  ]);

  // Surface any open refill request the user has for this Rx so the UI
  // can disable the "Request refill" button. Refills live in the unified
  // command queue, keyed by RXNO.
  const pending = await findOpenCommand(userId, "refill_request", rxno);

  return {
    rx: claimToListItem(claim, kind, drug, reasons),
    delivery: toDeliveryInfo(delivery.get(claim.refillNo)),
    prescriber,
    history: history.map((h) => ({
      refillNo: h.refillNo,
      filledAt: h.dateFilled ? h.dateFilled.toISOString().slice(0, 10) : null,
      qtyDispensed: h.qtyDispensed,
      pickedUp: h.pickedUp,
      pickupDate: h.pickupDate ? h.pickupDate.toISOString() : null,
      handoff: h.handoff,
      pickupTime: h.pickupTime,
      delivery: toDeliveryInfo(delivery.get(h.refillNo)),
      dispensed: (h.status ?? "").trim().toUpperCase() !== "F",
      filedReason: h.filedReasonId != null ? (reasons.get(h.filedReasonId) ?? null) : null,
    })),
    pendingRefillRequest: pending
      ? {
          id: pending.id,
          status: pending.status,
          requestedAt: pending.requestedAt,
        }
      : null,
  };
}

export interface QueueRefillInput {
  userId: string;
  kind: DbKind;
  patientno: number;
  rxno: string;
  refillNo: number | null;
  patientNote: string | null;
}

export async function queueRefillRequest(input: QueueRefillInput): Promise<{ id: string }> {
  // Verify the Rx actually exists and belongs to the patient before we put a
  // job on a pharmacist's desk.
  const claim = await getPrescription(input.kind, input.patientno, input.rxno);
  if (!claim) throw new HttpError(404, "prescription_not_found");
  if (claim.totalRefills > 0 && claim.refillNo >= claim.totalRefills) {
    throw new HttpError(409, "no_refills_remaining");
  }

  // Lands in the unified command queue; a pharmacist performs the refill in the
  // PrimeRX client. Dedupe is per-RXNO, so one open refill request per Rx.
  const cmd = await enqueueCommand({
    userId: input.userId,
    kind: input.kind,
    patientno: input.patientno,
    type: "refill_request",
    dedupeKey: input.rxno,
    patientNote: input.patientNote,
    payload: {
      rxno: input.rxno,
      refillNo: input.refillNo,
      drugName: claim.drgname ?? null,
    },
  });
  return { id: cmd.id };
}
