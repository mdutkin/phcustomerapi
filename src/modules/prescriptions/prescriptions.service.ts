// Prescription read service.
//
// Reads come from MSSQL (PrimeRX is the system of record). Refill
// requests are queued in PG (`refill_requests`); pharmacy staff process
// them in PrimeRX, and the resulting CLAIMS row updates downstream.

import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { refillRequests } from "@/db/schema";
import {
  getDrug,
  getPrescriber,
  getPrescription,
  getPrescriptionHistory,
  listPrescriptionsForPatient,
} from "@/db/mssql-models";
import type { DbKind, PrimeRxClaim, PrimeRxDrug, PrimeRxPrescriber } from "@/db/mssql-models";
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
  is340b: boolean;
}

function claimToListItem(c: PrimeRxClaim, kind: DbKind, drug: PrimeRxDrug | null): RxListItem {
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
    is340b: c.is340b,
  };
}

export async function listPrescriptions(kind: DbKind, patientno: number): Promise<RxListItem[]> {
  const claims = await listPrescriptionsForPatient(kind, patientno);
  // Hydrate drugs in parallel — most patients have a handful of distinct
  // NDCs, so a per-row fetch is fine for now. Optimise to batch SELECT
  // IN (...) when this list grows.
  const drugs = await Promise.all(
    claims.map((c) => (c.ndc ? getDrug(kind, c.ndc) : Promise.resolve(null))),
  );
  return claims.map((c, i) => claimToListItem(c, kind, drugs[i] ?? null));
}

export interface RxDetail {
  rx: RxListItem;
  prescriber: PrimeRxPrescriber | null;
  history: Array<{
    refillNo: number;
    filledAt: string | null;
    qtyDispensed: number | null;
    pickedUp: boolean;
    pickupDate: string | null;
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

  const [drug, prescriber, history] = await Promise.all([
    claim.ndc ? getDrug(kind, claim.ndc) : Promise.resolve(null),
    claim.presno !== null ? getPrescriber(kind, claim.presno) : Promise.resolve(null),
    getPrescriptionHistory(kind, patientno, rxno),
  ]);

  // Surface any open refill request the user has for this Rx so the UI
  // can disable the "Request refill" button.
  const [pending] = await db
    .select()
    .from(refillRequests)
    .where(
      and(
        eq(refillRequests.userId, userId),
        eq(refillRequests.dbKind, kind),
        eq(refillRequests.patientno, patientno),
        eq(refillRequests.rxno, rxno),
      ),
    )
    .orderBy(desc(refillRequests.requestedAt))
    .limit(1);

  const isOpen = pending && ["queued", "in_review", "accepted"].includes(pending.status);

  return {
    rx: claimToListItem(claim, kind, drug),
    prescriber,
    history: history.map((h) => ({
      refillNo: h.refillNo,
      filledAt: h.dateFilled ? h.dateFilled.toISOString().slice(0, 10) : null,
      qtyDispensed: h.qtyDispensed,
      pickedUp: h.pickedUp,
      pickupDate: h.pickupDate ? h.pickupDate.toISOString() : null,
    })),
    pendingRefillRequest: isOpen
      ? {
          id: pending!.id,
          status: pending!.status,
          requestedAt: pending!.requestedAt.toISOString(),
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
  // Reject duplicate open requests for the same Rx.
  const open = await db
    .select({ id: refillRequests.id, status: refillRequests.status })
    .from(refillRequests)
    .where(
      and(
        eq(refillRequests.userId, input.userId),
        eq(refillRequests.dbKind, input.kind),
        eq(refillRequests.patientno, input.patientno),
        eq(refillRequests.rxno, input.rxno),
      ),
    );
  if (open.some((r) => ["queued", "in_review", "accepted"].includes(r.status))) {
    throw new HttpError(409, "refill_already_pending");
  }

  // Verify the Rx actually exists and belongs to the patient.
  const claim = await getPrescription(input.kind, input.patientno, input.rxno);
  if (!claim) throw new HttpError(404, "prescription_not_found");
  if (claim.totalRefills > 0 && claim.refillNo >= claim.totalRefills) {
    throw new HttpError(409, "no_refills_remaining");
  }

  const [row] = await db
    .insert(refillRequests)
    .values({
      userId: input.userId,
      dbKind: input.kind,
      patientno: input.patientno,
      rxno: input.rxno,
      refillNo: input.refillNo,
      patientNote: input.patientNote,
    })
    .returning({ id: refillRequests.id });
  if (!row) throw new HttpError(500, "refill_queue_failed");
  return row;
}
