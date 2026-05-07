// Lab results — list + detail (with history series).
//
// Currently reads from PG (stub data). NextGen API integration will
// replace the data source here later.

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { labResults } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { HttpError } from "@/plugins/error-handler";

const LabRow = z.object({
  id: z.string().uuid(),
  testCode: z.string(),
  testName: z.string(),
  category: z.string().nullable(),
  source: z.string().nullable(),
  collectedAt: z.string(),
  value: z.string(),
  unit: z.string().nullable(),
  flag: z.string(),
  refLow: z.string().nullable(),
  refHigh: z.string().nullable(),
  refRangeText: z.string().nullable(),
  note: z.string().nullable(),
});

export const labRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/labs", {
    onRequest: [app.authenticate],
    schema: {
      tags: ["labs"],
      querystring: z.object({ category: z.string().optional() }),
      response: { 200: z.object({ items: z.array(LabRow) }) },
    },
  }, async (req) => {
    const userId = req.user.sub;

    const rows = await db
      .select()
      .from(labResults)
      .where(eq(labResults.userId, userId))
      .orderBy(desc(labResults.collectedAt));

    await recordAudit(req, {
      action: "labs.list",
      resourceType: "lab_result",
      subjectUserId: userId,
      metadata: { count: rows.length },
    });

    return {
      items: rows.map((r) => ({
        id: r.id,
        testCode: r.testCode,
        testName: r.testName,
        category: r.category,
        source: r.source,
        collectedAt: r.collectedAt.toISOString(),
        value: r.value,
        unit: r.unit,
        flag: r.flag,
        refLow: r.refLow,
        refHigh: r.refHigh,
        refRangeText: r.refRangeText,
        note: r.note,
      })),
    };
  });

  app.get("/labs/:id", {
    onRequest: [app.authenticate],
    schema: {
      tags: ["labs"],
      params: z.object({ id: z.string().uuid() }),
      response: {
        200: z.object({
          result: LabRow,
          history: z.array(
            z.object({
              collectedAt: z.string(),
              value: z.string(),
              flag: z.string(),
            }),
          ),
        }),
      },
    },
  }, async (req) => {
    const userId = req.user.sub;
    const { id } = req.params;

    const [result] = await db
      .select()
      .from(labResults)
      .where(and(eq(labResults.id, id), eq(labResults.userId, userId)))
      .limit(1);
    if (!result) throw new HttpError(404, "lab_result_not_found");

    const history = await db
      .select({
        collectedAt: labResults.collectedAt,
        value: labResults.value,
        flag: labResults.flag,
      })
      .from(labResults)
      .where(and(eq(labResults.userId, userId), eq(labResults.testCode, result.testCode)))
      .orderBy(asc(labResults.collectedAt));

    await recordAudit(req, {
      action: "lab_result.read",
      resourceType: "lab_result",
      resourceId: id,
      subjectUserId: userId,
    });

    return {
      result: {
        id: result.id,
        testCode: result.testCode,
        testName: result.testName,
        category: result.category,
        source: result.source,
        collectedAt: result.collectedAt.toISOString(),
        value: result.value,
        unit: result.unit,
        flag: result.flag,
        refLow: result.refLow,
        refHigh: result.refHigh,
        refRangeText: result.refRangeText,
        note: result.note,
      },
      history: history.map((h) => ({
        collectedAt: h.collectedAt.toISOString(),
        value: h.value,
        flag: h.flag,
      })),
    };
  });
};
