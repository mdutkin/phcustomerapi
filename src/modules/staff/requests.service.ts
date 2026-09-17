// Staff view of the command queue — every request a patient (or, later, the
// voice agent / auto-refill scheduler) has put on the pharmacy's desk.
//
// Lifecycle a pharmacist drives: pending → in_progress (claimed) → done |
// rejected. `canceled` is the patient's own withdrawal. Every transition is
// audited with who did it. Nothing here touches PrimeRX — "done" means the
// pharmacist performed it in the PrimeRX client and is telling us so.

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { commandQueue, users, type CommandStatus, type CommandType } from "@/db/schema";
import { getPatient, type DbKind } from "@/db/mssql-models";
import { HttpError } from "@/plugins/error-handler";

export interface StaffCommandView {
  id: string;
  type: CommandType;
  status: CommandStatus;
  dbKind: DbKind;
  patientno: number;
  patient: { lastName: string | null; firstName: string | null; dob: string | null; mobile: string | null } | null;
  requestedBy: { userId: string; phoneE164: string | null; email: string | null };
  payload: Record<string, unknown>;
  patientNote: string | null;
  staffNote: string | null;
  requestedAt: string;
  claimedBy: string | null;
  claimedAt: string | null;
  completedBy: string | null;
  completedAt: string | null;
}

const OPEN: CommandStatus[] = ["pending", "in_progress"];

export async function listStaffCommands(opts: {
  scope: "open" | "closed" | "all";
  type?: CommandType;
  limit: number;
}): Promise<StaffCommandView[]> {
  const conds = [];
  if (opts.scope === "open") conds.push(inArray(commandQueue.status, OPEN));
  if (opts.scope === "closed") conds.push(inArray(commandQueue.status, ["done", "rejected", "canceled", "failed"]));
  if (opts.type) conds.push(eq(commandQueue.type, opts.type));

  const rows = await db
    .select({ c: commandQueue, u: { id: users.id, phoneE164: users.phoneE164, email: users.email } })
    .from(commandQueue)
    .innerJoin(users, eq(users.id, commandQueue.userId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(commandQueue.requestedAt))
    .limit(opts.limit);

  // Patient names live in PrimeRX; look each distinct record up once.
  const keys = new Map<string, { dbKind: DbKind; patientno: number }>();
  for (const r of rows) keys.set(`${r.c.dbKind}|${r.c.patientno}`, { dbKind: r.c.dbKind, patientno: r.c.patientno });
  const patients = new Map<string, StaffCommandView["patient"]>();
  await Promise.all(
    [...keys.entries()].map(async ([k, v]) => {
      const p = await getPatient(v.dbKind, v.patientno).catch(() => null);
      patients.set(
        k,
        p
          ? { lastName: p.lastName, firstName: p.firstName, dob: p.dob ? p.dob.toISOString().slice(0, 10) : null, mobile: p.mobile ?? p.phone }
          : null,
      );
    }),
  );

  return rows.map(({ c, u }) => ({
    id: c.id,
    type: c.type,
    status: c.status,
    dbKind: c.dbKind,
    patientno: c.patientno,
    patient: patients.get(`${c.dbKind}|${c.patientno}`) ?? null,
    requestedBy: { userId: u.id, phoneE164: u.phoneE164, email: u.email },
    payload: c.payload,
    patientNote: c.patientNote,
    staffNote: c.staffNote,
    requestedAt: c.requestedAt.toISOString(),
    claimedBy: c.claimedBy,
    claimedAt: c.claimedAt ? c.claimedAt.toISOString() : null,
    completedBy: c.completedBy,
    completedAt: c.completedAt ? c.completedAt.toISOString() : null,
  }));
}

export type StaffTransition = "claim" | "release" | "done" | "reject";

export async function transitionCommand(input: {
  id: string;
  action: StaffTransition;
  actor: string; // staff email or uid, stored on the row
  note?: string | null;
}): Promise<{ id: string; status: CommandStatus }> {
  const row = (await db.select().from(commandQueue).where(eq(commandQueue.id, input.id)).limit(1))[0];
  if (!row) throw new HttpError(404, "request_not_found");
  const now = new Date();

  const allowed: Record<StaffTransition, CommandStatus[]> = {
    claim: ["pending"],
    release: ["in_progress"],
    done: ["pending", "in_progress"],
    reject: ["pending", "in_progress"],
  };
  if (!allowed[input.action].includes(row.status)) {
    throw new HttpError(409, "invalid_transition", `Cannot ${input.action} a request that is ${row.status}.`);
  }
  if (input.action === "reject" && !input.note?.trim()) {
    throw new HttpError(400, "reason_required", "A rejection needs a reason — the patient will see it.");
  }

  const patch: Partial<typeof commandQueue.$inferInsert> =
    input.action === "claim"
      ? { status: "in_progress", claimedBy: input.actor, claimedAt: now }
      : input.action === "release"
        ? { status: "pending", claimedBy: null, claimedAt: null }
        : input.action === "done"
          ? { status: "done", completedBy: input.actor, completedAt: now, staffNote: input.note ?? row.staffNote }
          : { status: "rejected", completedBy: input.actor, completedAt: now, staffNote: input.note ?? null };

  await db.update(commandQueue).set(patch).where(eq(commandQueue.id, input.id));
  return { id: input.id, status: patch.status as CommandStatus };
}
