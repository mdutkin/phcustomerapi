// Patient routes:
//   GET  /me            → user + linked PrimeRX patient (if any) + addresses
//   POST /me/claim      → self-claim a PrimeRX patient via DOB + last name + phone

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getMeForUser } from "./patients.service";
import { claimPatient } from "./claim.service";
import { recordAudit } from "@/lib/audit";

const DbKindSchema = z.enum(["340b", "conventional"]);

const PatientSchema = z.object({
  dbKind: DbKindSchema,
  patientno: z.number().int(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  dob: z.string().nullable(), // ISO date
  email: z.string().nullable(),
  phone: z.string().nullable(),
  mobile: z.string().nullable(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  zip: z.string().nullable(),
  is340b: z.boolean(),
  active: z.boolean(),
  primaryInsurance: z.string().nullable(),
  allergies: z.string().nullable(),
});

const MeResponse = z.object({
  user: z.object({
    id: z.string().uuid(),
    email: z.string().nullable(),
    phoneE164: z.string().nullable(),
    createdAt: z.string(),
  }),
  patient: PatientSchema.nullable(),
  addresses: z.array(
    z.object({
      id: z.string().uuid(),
      label: z.string(),
      line1: z.string(),
      line2: z.string().nullable(),
      city: z.string(),
      state: z.string(),
      postalCode: z.string(),
      isDefault: z.boolean(),
    }),
  ),
});

const ClaimBody = z.object({
  lastName: z.string().min(1).max(80),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  phone: z.string().min(4).max(32),
});

const ClaimResponse = z.object({
  ok: z.literal(true),
  patient: PatientSchema,
});

export const patientRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/me", {
    onRequest: [app.authenticate],
    schema: { tags: ["patient"], response: { 200: MeResponse } },
  }, async (req) => {
    const userId = req.user.sub;
    const out = await getMeForUser(userId);

    await recordAudit(req, {
      action: "me.read",
      resourceType: "user",
      resourceId: userId,
      subjectUserId: userId,
      metadata: out.link
        ? { dbKind: out.link.dbKind, patientno: out.link.patientno }
        : undefined,
    });

    return {
      user: {
        id: out.user.id,
        email: out.user.email,
        phoneE164: out.user.phoneE164,
        createdAt: out.user.createdAt.toISOString(),
      },
      patient:
        out.patient && out.link
          ? {
              dbKind: out.link.dbKind,
              patientno: out.patient.patientno,
              firstName: out.patient.firstName,
              lastName: out.patient.lastName,
              dob: out.patient.dob ? out.patient.dob.toISOString().slice(0, 10) : null,
              email: out.patient.email,
              phone: out.patient.phone,
              mobile: out.patient.mobile,
              addressLine1: out.patient.addressLine1,
              addressLine2: out.patient.addressLine2,
              city: out.patient.city,
              state: out.patient.state,
              zip: out.patient.zip,
              is340b: out.patient.is340b,
              active: out.patient.active,
              primaryInsurance: out.patient.primaryInsurance,
              allergies: out.patient.allergies,
            }
          : null,
      addresses: out.addresses,
    };
  });

  app.post("/me/claim", {
    onRequest: [app.authenticate],
    schema: {
      tags: ["patient"],
      body: ClaimBody,
      response: { 200: ClaimResponse, 201: ClaimResponse },
    },
  }, async (req, reply) => {
    const userId = req.user.sub;
    const result = await claimPatient(userId, req.body);

    await recordAudit(req, {
      action: "patient.claim",
      resourceType: "user_patient",
      resourceId: `${result.dbKind}:${result.patientno}`,
      subjectUserId: userId,
      metadata: { dbKind: result.dbKind, patientno: result.patientno },
    });

    reply.code(201);
    return {
      ok: true as const,
      patient: {
        dbKind: result.dbKind,
        patientno: result.patient.patientno,
        firstName: result.patient.firstName,
        lastName: result.patient.lastName,
        dob: result.patient.dob ? result.patient.dob.toISOString().slice(0, 10) : null,
        email: result.patient.email,
        phone: result.patient.phone,
        mobile: result.patient.mobile,
        addressLine1: result.patient.addressLine1,
        addressLine2: result.patient.addressLine2,
        city: result.patient.city,
        state: result.patient.state,
        zip: result.patient.zip,
        is340b: result.patient.is340b,
        active: result.patient.active,
        primaryInsurance: result.patient.primaryInsurance,
        allergies: result.patient.allergies,
      },
    };
  });
};
