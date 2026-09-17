// Aggregated refill work list: both PrimeRX databases, one row per PERSON.
//
// The same human exists in PharmSQL (340B) and PharmSQLCONVENTIONAL under
// different PATIENTNOs, so we merge on (last name, first name, DOB) — the same
// identity axis the claim flow uses to disambiguate a phone line. A pharmacist
// then makes ONE call for everything that person is due, not one per database.
//
// Ranking is by how actionable the row is: written authorisation in hand and
// already run out first (fill it — no call needed), then run out, then merely
// due. Our own command_queue (patient-initiated) is layered on so a portal
// request and a due Rx for the same person show together.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { commandQueue } from "@/db/schema";
import { getWorklist, type WorklistRxRow } from "@/db/mssql-models";
import type { MssqlKind } from "@/db/mssql";

export type WorklistDb = MssqlKind;

export interface WorklistRx {
  db: WorklistDb;
  patientno: number;
  rxno: string;
  drugName: string | null;
  drugStrength: string | null;
  deaClass: number;
  lastFilledAt: string | null;
  daysSupply: number | null;
  refillsRemaining: number;
  /** Signed; negative = ran out that many days ago. */
  daysRemaining: number | null;
  dueDate: string | null;
  /** Live per-Rx auto-refill consent → may be filled without a call. */
  consentUntil: string | null;
  handoff: "delivery" | "pickup";
  inPrimeRxQueueSince: string | null;
  /** Open patient-initiated request from the portal, if any. */
  portalRequestId: string | null;
  portalRequestedAt: string | null;
}

export interface WorklistPerson {
  /** Stable within a snapshot: "LNAME|FNAME|YYYY-MM-DD". */
  key: string;
  lastName: string | null;
  firstName: string | null;
  dob: string | null;
  mobile: string | null;
  phone: string | null;
  languageNo: number | null;
  /** Which DB(s) this person exists in, with their PATIENTNO in each. */
  records: Array<{ db: WorklistDb; patientno: number }>;
  rx: WorklistRx[];
  // Summary for sorting/filtering without walking rx[]
  rxCount: number;
  consentCount: number;
  ranOutCount: number;
  mostOverdueDays: number; // max(-daysRemaining, 0)
  hasPortalRequest: boolean;
  priority: number;
}

export interface WorklistSnapshot {
  generatedAt: string;
  people: WorklistPerson[];
  totals: {
    people: number;
    rx: number;
    withConsent: number;
    ranOut: number;
    byDb: Record<WorklistDb, { people: number; rx: number }>;
  };
}

const TTL_MS = 5 * 60 * 1000;
let cache: { at: number; snap: WorklistSnapshot } | null = null;
let inflight: Promise<WorklistSnapshot> | null = null;

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const norm = (s: string | null) => (s ?? "").toUpperCase().replace(/[^A-Z]/g, "");

function personKey(r: WorklistRxRow): string {
  return `${norm(r.lastName)}|${norm(r.firstName)}|${iso(r.dob) ?? ""}`;
}

async function build(): Promise<WorklistSnapshot> {
  const [rows340b, rowsConv] = await Promise.all([getWorklist("340b"), getWorklist("conventional")]);
  const all: Array<{ db: WorklistDb; row: WorklistRxRow }> = [
    ...rows340b.map((row) => ({ db: "340b" as const, row })),
    ...rowsConv.map((row) => ({ db: "conventional" as const, row })),
  ];

  // Open portal refill requests, keyed by (db, rxno).
  const open = await db
    .select({
      id: commandQueue.id,
      dbKind: commandQueue.dbKind,
      payload: commandQueue.payload,
      requestedAt: commandQueue.requestedAt,
    })
    .from(commandQueue)
    .where(and(eq(commandQueue.type, "refill_request"), inArray(commandQueue.status, ["pending", "in_progress"])));
  const portalByRx = new Map<string, { id: string; at: Date }>();
  for (const c of open) {
    const rxno = String((c.payload as { rxno?: string }).rxno ?? "");
    if (rxno) portalByRx.set(`${c.dbKind}|${rxno}`, { id: c.id, at: c.requestedAt });
  }

  const people = new Map<string, WorklistPerson>();
  for (const { db: kind, row } of all) {
    const key = personKey(row);
    let p = people.get(key);
    if (!p) {
      p = {
        key,
        lastName: row.lastName,
        firstName: row.firstName,
        dob: iso(row.dob),
        mobile: row.mobile,
        phone: row.phone,
        languageNo: row.languageNo,
        records: [],
        rx: [],
        rxCount: 0,
        consentCount: 0,
        ranOutCount: 0,
        mostOverdueDays: 0,
        hasPortalRequest: false,
        priority: 0,
      };
      people.set(key, p);
    }
    if (!p.records.some((r) => r.db === kind && r.patientno === row.patientno)) {
      p.records.push({ db: kind, patientno: row.patientno });
    }
    // Prefer a mobile from whichever record has one.
    p.mobile ??= row.mobile;
    p.phone ??= row.phone;
    p.languageNo ??= row.languageNo;

    const portal = portalByRx.get(`${kind}|${row.rxno}`) ?? null;
    const overdue = Math.max(0, -(row.daysRemaining ?? 0));
    p.rx.push({
      db: kind,
      patientno: row.patientno,
      rxno: row.rxno,
      drugName: row.drugName,
      drugStrength: row.drugStrength,
      deaClass: row.deaClass,
      lastFilledAt: iso(row.lastFilledAt),
      daysSupply: row.daysSupply,
      refillsRemaining: row.refillsRemaining,
      daysRemaining: row.daysRemaining,
      dueDate: iso(row.dueDate),
      consentUntil: iso(row.consentUntil),
      handoff: row.handoff,
      inPrimeRxQueueSince: iso(row.inPrimeRxQueueSince),
      portalRequestId: portal?.id ?? null,
      portalRequestedAt: portal ? portal.at.toISOString() : null,
    });
    p.rxCount++;
    if (row.consentUntil) p.consentCount++;
    if (overdue > 0) p.ranOutCount++;
    p.mostOverdueDays = Math.max(p.mostOverdueDays, overdue);
    if (portal) p.hasPortalRequest = true;
  }

  const list = [...people.values()];
  for (const p of list) {
    // Sort each person's Rx most-overdue first.
    p.rx.sort((a, b) => (a.daysRemaining ?? 0) - (b.daysRemaining ?? 0));
    // Priority: a patient asked (portal) > authorised & ran out > ran out > due.
    p.priority =
      (p.hasPortalRequest ? 4000 : 0) +
      (p.consentCount > 0 && p.ranOutCount > 0 ? 2000 : 0) +
      (p.ranOutCount > 0 ? 1000 : 0) +
      Math.min(p.mostOverdueDays, 999);
  }
  list.sort((a, b) => b.priority - a.priority || (a.lastName ?? "").localeCompare(b.lastName ?? ""));

  const byDb: WorklistSnapshot["totals"]["byDb"] = {
    "340b": { people: new Set(rows340b.map((r) => r.patientno)).size, rx: rows340b.length },
    conventional: { people: new Set(rowsConv.map((r) => r.patientno)).size, rx: rowsConv.length },
  };
  return {
    generatedAt: new Date().toISOString(),
    people: list,
    totals: {
      people: list.length,
      rx: all.length,
      withConsent: list.filter((p) => p.consentCount > 0).length,
      ranOut: list.filter((p) => p.ranOutCount > 0).length,
      byDb,
    },
  };
}

/** Cached for TTL_MS; the two RefDueView scans cost ~5s each. */
export async function getWorklistSnapshot(opts: { refresh?: boolean } = {}): Promise<WorklistSnapshot> {
  if (!opts.refresh && cache && Date.now() - cache.at < TTL_MS) return cache.snap;
  if (!inflight) {
    inflight = build()
      .then((snap) => {
        cache = { at: Date.now(), snap };
        return snap;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
