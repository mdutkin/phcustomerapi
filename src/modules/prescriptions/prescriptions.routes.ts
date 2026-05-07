// Prescription routes — read PrimeRX (MSSQL), queue refills (PG).
//
// All endpoints require a claimed PrimeRX patient link. If the user
// hasn't claimed yet, /me/claim must be called first; until then these
// endpoints return 409 patient_not_linked.

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requirePatientLink } from "../patients/patients.service";
import {
  getPrescriptionDetail,
  listPrescriptions,
  queueRefillRequest,
} from "./prescriptions.service";
import { recordAudit } from "@/lib/audit";

const RxNoParam = z.object({ rxno: z.string().regex(/^\d{1,32}$/) });

const RxListItemSchema = z.object({
  rxno: z.string(),
  dbKind: z.enum(["340b", "conventional"]),
  drugName: z.string().nullable(),
  drugStrength: z.string().nullable(),
  drugForm: z.string().nullable(),
  ndc: z.string().nullable(),
  sig: z.string().nullable(),
  daysSupply: z.number().int().nullable(),
  qtyOrdered: z.number().nullable(),
  refillsRemaining: z.number().int(),
  refillsTotal: z.number().int(),
  status: z.string().nullable(),
  lastFilledAt: z.string().nullable(),
  pickedUp: z.boolean(),
  pickupDate: z.string().nullable(),
  is340b: z.boolean(),
});

const RxDetailResponse = z.object({
  rx: RxListItemSchema,
  prescriber: z
    .object({
      presno: z.number().int(),
      firstName: z.string().nullable(),
      lastName: z.string().nullable(),
      npi: z.string().nullable(),
      phone: z.string().nullable(),
      fax: z.string().nullable(),
      email: z.string().nullable(),
    })
    .nullable(),
  history: z.array(
    z.object({
      refillNo: z.number().int(),
      filledAt: z.string().nullable(),
      qtyDispensed: z.number().nullable(),
      pickedUp: z.boolean(),
      pickupDate: z.string().nullable(),
    }),
  ),
  pendingRefillRequest: z
    .object({
      id: z.string().uuid(),
      status: z.string(),
      requestedAt: z.string(),
    })
    .nullable(),
});

export const prescriptionRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/prescriptions", {
    onRequest: [app.authenticate],
    schema: {
      tags: ["prescriptions"],
      response: { 200: z.object({ items: z.array(RxListItemSchema) }) },
    },
  }, async (req) => {
    const userId = req.user.sub;
    const link = await requirePatientLink(userId);
    const items = await listPrescriptions(link.dbKind, link.patientno);

    await recordAudit(req, {
      action: "prescriptions.list",
      resourceType: "prescription",
      subjectUserId: userId,
      metadata: { dbKind: link.dbKind, patientno: link.patientno, count: items.length },
    });

    return { items };
  });

  app.get("/prescriptions/:rxno", {
    onRequest: [app.authenticate],
    schema: {
      tags: ["prescriptions"],
      params: RxNoParam,
      response: { 200: RxDetailResponse },
    },
  }, async (req) => {
    const userId = req.user.sub;
    const link = await requirePatientLink(userId);
    const detail = await getPrescriptionDetail(userId, link.dbKind, link.patientno, req.params.rxno);

    await recordAudit(req, {
      action: "prescription.read",
      resourceType: "prescription",
      resourceId: `${link.dbKind}:${req.params.rxno}`,
      subjectUserId: userId,
      metadata: { dbKind: link.dbKind, patientno: link.patientno, rxno: req.params.rxno },
    });

    return {
      rx: detail.rx,
      prescriber: detail.prescriber
        ? {
            presno: detail.prescriber.presno,
            firstName: detail.prescriber.firstName,
            lastName: detail.prescriber.lastName,
            npi: detail.prescriber.npi,
            phone: detail.prescriber.phone,
            fax: detail.prescriber.fax,
            email: detail.prescriber.email,
          }
        : null,
      history: detail.history,
      pendingRefillRequest: detail.pendingRefillRequest,
    };
  });

  app.post("/prescriptions/:rxno/refill", {
    onRequest: [app.authenticate],
    schema: {
      tags: ["prescriptions"],
      params: RxNoParam,
      body: z
        .object({
          patientNote: z.string().max(500).optional(),
        })
        .optional(),
      response: {
        202: z.object({
          status: z.literal("queued"),
          refillRequestId: z.string().uuid(),
          rxno: z.string(),
        }),
      },
    },
  }, async (req, reply) => {
    const userId = req.user.sub;
    const link = await requirePatientLink(userId);
    const { id } = await queueRefillRequest({
      userId,
      kind: link.dbKind,
      patientno: link.patientno,
      rxno: req.params.rxno,
      refillNo: null,
      patientNote: req.body?.patientNote ?? null,
    });

    await recordAudit(req, {
      action: "prescription.refill_request",
      resourceType: "refill_request",
      resourceId: id,
      subjectUserId: userId,
      metadata: { dbKind: link.dbKind, patientno: link.patientno, rxno: req.params.rxno },
    });

    reply.code(202);
    return { status: "queued" as const, refillRequestId: id, rxno: req.params.rxno };
  });
};
