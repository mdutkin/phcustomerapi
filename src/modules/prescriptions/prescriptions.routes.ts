// Prescription routes — list, detail, refill request stubs.

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { drugs, patients, prescribers, prescriptions, refillEvents } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { HttpError } from "@/plugins/error-handler";

const RxItem = z.object({
  id: z.string().uuid(),
  rxNumber: z.string(),
  drug: z.object({
    id: z.string().uuid().nullable(),
    name: z.string(),
    strength: z.string().nullable(),
    form: z.string().nullable(),
  }),
  sig: z.string(),
  qtyPerFill: z.number().int(),
  daysSupply: z.number().int(),
  refillsRemaining: z.number().int(),
  refillsTotal: z.number().int(),
  status: z.string(),
  purpose: z.string().nullable(),
  pricePerFill: z.string().nullable(),
  lastFilledAt: z.string().nullable(),
  nextRefillAt: z.string().nullable(),
});

async function patientIdForUser(userId: string): Promise<string> {
  const [row] = await db
    .select({ id: patients.id })
    .from(patients)
    .where(eq(patients.userId, userId))
    .limit(1);
  if (!row) throw new HttpError(404, "patient_not_found");
  return row.id;
}

export const prescriptionRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/prescriptions", {
    onRequest: [app.authenticate],
    schema: {
      tags: ["prescriptions"],
      querystring: z.object({ status: z.string().optional() }),
      response: { 200: z.object({ items: z.array(RxItem) }) },
    },
  }, async (req) => {
    const patientId = await patientIdForUser(req.user.sub);
    const conditions = [eq(prescriptions.patientId, patientId)];
    // status filter omitted in initial cut — handled by client for now.

    const rows = await db
      .select({
        rx: prescriptions,
        drug: drugs,
      })
      .from(prescriptions)
      .leftJoin(drugs, eq(drugs.id, prescriptions.drugId))
      .where(and(...conditions))
      .orderBy(desc(prescriptions.updatedAt));

    await recordAudit(req, {
      action: "prescriptions.list",
      resourceType: "prescription",
      patientId,
      metadata: { count: rows.length },
    });

    return {
      items: rows.map(({ rx, drug }) => ({
        id: rx.id,
        rxNumber: rx.rxNumber,
        drug: {
          id: drug?.id ?? null,
          name: drug?.name ?? "Unknown",
          strength: drug?.strength ?? null,
          form: drug?.form ?? null,
        },
        sig: rx.sig,
        qtyPerFill: rx.qtyPerFill,
        daysSupply: rx.daysSupply,
        refillsRemaining: rx.refillsRemaining,
        refillsTotal: rx.refillsTotal,
        status: rx.status,
        purpose: rx.purpose,
        pricePerFill: rx.pricePerFill,
        lastFilledAt: rx.lastFilledAt,
        nextRefillAt: rx.nextRefillAt,
      })),
    };
  });

  app.get("/prescriptions/:id", {
    onRequest: [app.authenticate],
    schema: {
      tags: ["prescriptions"],
      params: z.object({ id: z.string().uuid() }),
      response: {
        200: z.object({
          rx: RxItem,
          prescriber: z
            .object({
              id: z.string().uuid(),
              name: z.string(),
              specialty: z.string().nullable(),
              clinic: z.string().nullable(),
              phone: z.string().nullable(),
            })
            .nullable(),
          history: z.array(
            z.object({
              id: z.string().uuid(),
              filledAt: z.string(),
              qty: z.number().int(),
              pricePaid: z.string().nullable(),
            }),
          ),
        }),
      },
    },
  }, async (req) => {
    const patientId = await patientIdForUser(req.user.sub);
    const { id } = req.params;

    const [row] = await db
      .select({ rx: prescriptions, drug: drugs })
      .from(prescriptions)
      .leftJoin(drugs, eq(drugs.id, prescriptions.drugId))
      .where(and(eq(prescriptions.id, id), eq(prescriptions.patientId, patientId)))
      .limit(1);
    if (!row) throw new HttpError(404, "prescription_not_found");

    const [presc] = row.rx.prescriberId
      ? await db.select().from(prescribers).where(eq(prescribers.id, row.rx.prescriberId)).limit(1)
      : [];

    const history = await db
      .select()
      .from(refillEvents)
      .where(eq(refillEvents.prescriptionId, id))
      .orderBy(desc(refillEvents.filledAt));

    await recordAudit(req, {
      action: "prescription.read",
      resourceType: "prescription",
      resourceId: id,
      patientId,
    });

    return {
      rx: {
        id: row.rx.id,
        rxNumber: row.rx.rxNumber,
        drug: {
          id: row.drug?.id ?? null,
          name: row.drug?.name ?? "Unknown",
          strength: row.drug?.strength ?? null,
          form: row.drug?.form ?? null,
        },
        sig: row.rx.sig,
        qtyPerFill: row.rx.qtyPerFill,
        daysSupply: row.rx.daysSupply,
        refillsRemaining: row.rx.refillsRemaining,
        refillsTotal: row.rx.refillsTotal,
        status: row.rx.status,
        purpose: row.rx.purpose,
        pricePerFill: row.rx.pricePerFill,
        lastFilledAt: row.rx.lastFilledAt,
        nextRefillAt: row.rx.nextRefillAt,
      },
      prescriber: presc
        ? {
            id: presc.id,
            name: presc.name,
            specialty: presc.specialty,
            clinic: presc.clinic,
            phone: presc.phone,
          }
        : null,
      history: history.map((h) => ({
        id: h.id,
        filledAt: h.filledAt.toISOString(),
        qty: h.qty,
        pricePaid: h.pricePaid,
      })),
    };
  });

  // Refill request — stub for now. Real flow will queue a pharmacy task.
  app.post("/prescriptions/:id/refill", {
    onRequest: [app.authenticate],
    schema: {
      tags: ["prescriptions"],
      params: z.object({ id: z.string().uuid() }),
      response: { 202: z.object({ status: z.literal("queued"), prescriptionId: z.string().uuid() }) },
    },
  }, async (req, reply) => {
    const patientId = await patientIdForUser(req.user.sub);
    const { id } = req.params;
    const [row] = await db
      .select({ id: prescriptions.id })
      .from(prescriptions)
      .where(and(eq(prescriptions.id, id), eq(prescriptions.patientId, patientId)))
      .limit(1);
    if (!row) throw new HttpError(404, "prescription_not_found");

    await recordAudit(req, {
      action: "prescription.refill_request",
      resourceType: "prescription",
      resourceId: id,
      patientId,
    });

    reply.code(202);
    return { status: "queued" as const, prescriptionId: id };
  });
};
