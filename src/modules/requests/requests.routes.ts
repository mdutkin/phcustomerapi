// Patient-facing view of the command queue: "my requests" + withdraw.
//
// Creating requests happens on the domain routes that own them (e.g.
// POST /prescriptions/:rxno/refill) so validation lives next to the domain.
// This module is the generic read/cancel surface plus the non-Rx request
// types (details / delivery changes).

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import * as svc from "./requests.service";
import { requirePatientLink } from "@/modules/patients/patients.service";
import { recordAudit } from "@/lib/audit";
import { HttpError } from "@/plugins/error-handler";

const CommandView = z.object({
  id: z.string().uuid(),
  type: z.enum(["refill_request", "update_details", "update_delivery"]),
  status: z.enum(["pending", "in_progress", "done", "rejected", "canceled", "failed"]),
  payload: z.record(z.unknown()),
  patientNote: z.string().nullable(),
  staffNote: z.string().nullable(),
  requestedAt: z.string(),
  completedAt: z.string().nullable(),
});

// Only the fields a patient may ask us to change. Anything not listed is
// deliberately not self-service.
const UpdateDetailsBody = z.object({
  phone: z.string().min(8).max(20).optional(),
  email: z.string().email().optional(),
  addressLine1: z.string().min(1).max(120).optional(),
  addressLine2: z.string().max(120).optional(),
  city: z.string().max(60).optional(),
  state: z.string().max(2).optional(),
  zip: z.string().max(10).optional(),
  note: z.string().max(500).optional(),
});

export const requestRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/requests", {
    onRequest: [app.authenticate],
    schema: { tags: ["requests"], response: { 200: z.array(CommandView) } },
  }, async (req) => {
    return svc.listMyCommands(req.user.sub);
  });

  app.post("/requests/:id/cancel", {
    onRequest: [app.authenticate],
    schema: {
      tags: ["requests"],
      params: z.object({ id: z.string().uuid() }),
      response: { 200: CommandView },
    },
  }, async (req) => {
    const out = await svc.cancelMyCommand(req.user.sub, req.params.id);
    await recordAudit(req, {
      action: "request.cancel",
      resourceType: "command",
      resourceId: req.params.id,
      actorUserId: req.user.sub,
    });
    return out;
  });

  // Ask the pharmacy to change demographics. NOT applied directly — a
  // pharmacist makes the change in the PrimeRX client.
  app.post("/requests/update-details", {
    onRequest: [app.authenticate],
    schema: { tags: ["requests"], body: UpdateDetailsBody, response: { 201: CommandView } },
  }, async (req, reply) => {
    const link = await requirePatientLink(req.user.sub);
    const { note, ...fields } = req.body;
    if (Object.keys(fields).length === 0) {
      throw new HttpError(400, "no_changes_requested", "Include at least one field to change.");
    }
    const out = await svc.enqueueCommand({
      userId: req.user.sub,
      kind: link.dbKind,
      patientno: link.patientno,
      type: "update_details",
      // One open details request at a time per patient.
      dedupeKey: "self",
      patientNote: note ?? null,
      payload: fields,
    });
    await recordAudit(req, {
      action: "request.update_details",
      resourceType: "command",
      resourceId: out.id,
      actorUserId: req.user.sub,
      metadata: { fields: Object.keys(fields), dbKind: link.dbKind, patientno: link.patientno },
    });
    reply.code(201);
    return out;
  });
};
