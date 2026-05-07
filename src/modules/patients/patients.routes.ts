// Patient routes — /me returns demographics + insurance + addresses.

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getPatientForUser } from "./patients.service";
import { recordAudit } from "@/lib/audit";

const PatientResponse = z.object({
  patient: z.object({
    id: z.string().uuid(),
    firstName: z.string(),
    lastName: z.string(),
    dob: z.string(),
    phoneE164: z.string().nullable(),
    email: z.string().nullable(),
    allergies: z.array(z.string()),
    conditions: z.array(z.string()),
  }),
  insurance: z
    .object({
      plan: z.string(),
      memberId: z.string(),
      groupId: z.string().nullable(),
    })
    .nullable(),
  addresses: z.array(
    z.object({
      id: z.string().uuid(),
      label: z.string(),
      line1: z.string(),
      line2: z.string().nullable(),
      city: z.string(),
      state: z.string(),
      postalCode: z.string(),
    }),
  ),
});

export const patientRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/me", {
    onRequest: [app.authenticate],
    schema: { tags: ["patient"], response: { 200: PatientResponse } },
  }, async (req) => {
    const userId = req.user.sub;
    const out = await getPatientForUser(userId);

    await recordAudit(req, {
      action: "patient.read",
      resourceType: "patient",
      resourceId: out.patient.id,
      patientId: out.patient.id,
    });

    return {
      patient: {
        id: out.patient.id,
        firstName: out.patient.firstName,
        lastName: out.patient.lastName,
        dob: out.patient.dob,
        phoneE164: out.patient.phoneE164,
        email: out.patient.email,
        allergies: out.patient.allergies,
        conditions: out.patient.conditions,
      },
      insurance: out.insurance
        ? {
            plan: out.insurance.plan,
            memberId: out.insurance.memberId,
            groupId: out.insurance.groupId,
          }
        : null,
      addresses: out.addresses.map((a) => ({
        id: a.id,
        label: a.label,
        line1: a.line1,
        line2: a.line2,
        city: a.city,
        state: a.state,
        postalCode: a.postalCode,
      })),
    };
  });
};
