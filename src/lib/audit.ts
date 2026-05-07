// Centralised audit logging. Always async-await this — losing audit records
// is worse than losing the request. Pino logs the same event in parallel for
// observability.

import type { FastifyRequest } from "fastify";
import { db } from "@/db/client";
import { auditLog } from "@/db/schema";

export interface AuditEvent {
  action: string;
  resourceType: string;
  resourceId?: string;
  patientId?: string;
  actorUserId?: string;
  actorIp?: string;
  metadata?: Record<string, unknown>;
}

export async function recordAudit(req: FastifyRequest | null, event: AuditEvent): Promise<void> {
  const actorUserId = event.actorUserId ?? req?.user?.sub;
  const actorIp = event.actorIp ?? req?.ip;

  try {
    await db.insert(auditLog).values({
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      patientId: event.patientId,
      actorUserId,
      actorIp,
      metadata: event.metadata,
    });
  } catch (err) {
    req?.log.error({ err, event }, "audit-log write failed");
  }

  req?.log.info({ audit: { ...event, actorUserId, actorIp } }, "audit");
}
