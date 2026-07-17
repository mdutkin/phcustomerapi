// Command queue service — the pharmacist's inbox.
//
// Patients enqueue commands; a pharmacist performs them in the PrimeRX client
// and marks them done here. Nothing in this file ever writes to MSSQL.

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import {
  commandQueue,
  OPEN_COMMAND_STATUSES,
  type CommandStatus,
  type CommandType,
  type DbKind,
} from "@/db/schema";
import { HttpError } from "@/plugins/error-handler";

export interface EnqueueInput {
  userId: string;
  kind: DbKind;
  patientno: number;
  type: CommandType;
  payload: Record<string, unknown>;
  /** Collapses duplicate open requests for the same target (e.g. an RXNO). */
  dedupeKey: string;
  patientNote?: string | null;
}

export interface CommandView {
  id: string;
  type: CommandType;
  status: CommandStatus;
  payload: Record<string, unknown>;
  patientNote: string | null;
  staffNote: string | null;
  requestedAt: string;
  completedAt: string | null;
}

function toView(r: typeof commandQueue.$inferSelect): CommandView {
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    payload: r.payload,
    patientNote: r.patientNote,
    staffNote: r.staffNote,
    requestedAt: r.requestedAt.toISOString(),
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
  };
}

export async function enqueueCommand(input: EnqueueInput): Promise<CommandView> {
  const existing = await db
    .select()
    .from(commandQueue)
    .where(
      and(
        eq(commandQueue.userId, input.userId),
        eq(commandQueue.type, input.type),
        eq(commandQueue.dedupeKey, input.dedupeKey),
        inArray(commandQueue.status, OPEN_COMMAND_STATUSES),
      ),
    )
    .limit(1);
  if (existing[0]) {
    throw new HttpError(409, "request_already_pending", "You already have an open request for this.");
  }

  try {
    const [row] = await db
      .insert(commandQueue)
      .values({
        userId: input.userId,
        dbKind: input.kind,
        patientno: input.patientno,
        type: input.type,
        payload: input.payload,
        dedupeKey: input.dedupeKey,
        patientNote: input.patientNote ?? null,
      })
      .returning();
    if (!row) throw new HttpError(500, "enqueue_failed");
    return toView(row);
  } catch (err) {
    // Partial unique index is the real guard — a concurrent insert races here.
    if (err instanceof HttpError) throw err;
    if (String(err).includes("command_queue_open_uniq")) {
      throw new HttpError(409, "request_already_pending", "You already have an open request for this.");
    }
    throw err;
  }
}

/** The open command of a given type for a target, if any (for UI badges). */
export async function findOpenCommand(
  userId: string,
  type: CommandType,
  dedupeKey: string,
): Promise<CommandView | null> {
  const [row] = await db
    .select()
    .from(commandQueue)
    .where(
      and(
        eq(commandQueue.userId, userId),
        eq(commandQueue.type, type),
        eq(commandQueue.dedupeKey, dedupeKey),
        inArray(commandQueue.status, OPEN_COMMAND_STATUSES),
      ),
    )
    .limit(1);
  return row ? toView(row) : null;
}

export async function listMyCommands(userId: string, limit = 50): Promise<CommandView[]> {
  const rows = await db
    .select()
    .from(commandQueue)
    .where(eq(commandQueue.userId, userId))
    .orderBy(desc(commandQueue.requestedAt))
    .limit(limit);
  return rows.map(toView);
}

/** Patients may withdraw only while nobody has picked it up. */
export async function cancelMyCommand(userId: string, id: string): Promise<CommandView> {
  const [row] = await db.select().from(commandQueue).where(eq(commandQueue.id, id)).limit(1);
  if (!row || row.userId !== userId) throw new HttpError(404, "request_not_found");
  if (row.status !== "pending") {
    throw new HttpError(409, "request_not_cancelable", "The pharmacy has already started on this request.");
  }
  const [updated] = await db
    .update(commandQueue)
    .set({ status: "canceled", completedAt: new Date() })
    .where(eq(commandQueue.id, id))
    .returning();
  return toView(updated!);
}

// ─── Pharmacist-facing ────────────────────────────────────────────────────

export async function listQueue(status: CommandStatus[] = ["pending", "in_progress"], limit = 100) {
  return db
    .select()
    .from(commandQueue)
    .where(inArray(commandQueue.status, status))
    .orderBy(commandQueue.requestedAt) // oldest first — FIFO inbox
    .limit(limit);
}

export async function claimCommand(id: string, staff: string) {
  const [row] = await db.select().from(commandQueue).where(eq(commandQueue.id, id)).limit(1);
  if (!row) throw new HttpError(404, "command_not_found");
  if (row.status !== "pending") throw new HttpError(409, "command_not_claimable");
  const [updated] = await db
    .update(commandQueue)
    .set({ status: "in_progress", claimedBy: staff, claimedAt: new Date() })
    .where(and(eq(commandQueue.id, id), eq(commandQueue.status, "pending")))
    .returning();
  if (!updated) throw new HttpError(409, "command_not_claimable");
  return updated;
}

/** Pharmacist performed it in PrimeRX; `result` is the audit snapshot. */
export async function completeCommand(
  id: string,
  staff: string,
  result?: Record<string, unknown>,
  note?: string,
) {
  const [row] = await db.select().from(commandQueue).where(eq(commandQueue.id, id)).limit(1);
  if (!row) throw new HttpError(404, "command_not_found");
  if (!OPEN_COMMAND_STATUSES.includes(row.status)) throw new HttpError(409, "command_not_open");
  const [updated] = await db
    .update(commandQueue)
    .set({
      status: "done",
      completedBy: staff,
      completedAt: new Date(),
      result: result ?? null,
      staffNote: note ?? row.staffNote,
    })
    .where(eq(commandQueue.id, id))
    .returning();
  return updated!;
}

export async function rejectCommand(id: string, staff: string, reason: string) {
  const [row] = await db.select().from(commandQueue).where(eq(commandQueue.id, id)).limit(1);
  if (!row) throw new HttpError(404, "command_not_found");
  if (!OPEN_COMMAND_STATUSES.includes(row.status)) throw new HttpError(409, "command_not_open");
  const [updated] = await db
    .update(commandQueue)
    .set({ status: "rejected", completedBy: staff, completedAt: new Date(), staffNote: reason })
    .where(eq(commandQueue.id, id))
    .returning();
  return updated!;
}
