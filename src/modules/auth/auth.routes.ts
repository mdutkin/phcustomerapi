// Auth route module. Endpoints under /auth/*.

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import * as svc from "./auth.service";
import { recordAudit } from "@/lib/audit";

const PhoneBody = z.object({ phone: z.string().min(8) });
const VerifyBody = z.object({ phone: z.string().min(8), code: z.string().regex(/^\d{4,8}$/) });
const EmailBody = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
});
const RefreshBody = z.object({ refreshToken: z.string().min(20) });

const SessionResponse = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  user: z.object({ id: z.string().uuid() }),
});

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post("/auth/otp/request", {
    schema: {
      tags: ["auth"],
      body: PhoneBody,
      response: {
        200: z.object({ ok: z.literal(true), devCode: z.string().optional() }),
      },
    },
  }, async (req) => {
    const { phone } = req.body;
    const out = await svc.issueOtp(phone);
    await recordAudit(req, { action: "otp.issue", resourceType: "phone", resourceId: phone });
    return { ok: true as const, ...out };
  });

  app.post("/auth/otp/verify", {
    schema: { tags: ["auth"], body: VerifyBody, response: { 200: SessionResponse } },
  }, async (req) => {
    const { phone, code } = req.body;
    const session = await svc.verifyOtp(phone, code, {
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    });
    const accessToken = app.signAccessToken({ sub: session.userId });
    await recordAudit(req, {
      action: "auth.login.otp",
      resourceType: "user",
      resourceId: session.userId,
      actorUserId: session.userId,
    });
    return {
      accessToken,
      refreshToken: session.refreshToken,
      user: { id: session.userId },
    };
  });

  app.post("/auth/login/email", {
    schema: { tags: ["auth"], body: EmailBody, response: { 200: SessionResponse } },
  }, async (req) => {
    const { email, password } = req.body;
    const session = await svc.loginEmail(email, password, {
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    });
    const accessToken = app.signAccessToken({ sub: session.userId });
    await recordAudit(req, {
      action: "auth.login.email",
      resourceType: "user",
      resourceId: session.userId,
      actorUserId: session.userId,
    });
    return {
      accessToken,
      refreshToken: session.refreshToken,
      user: { id: session.userId },
    };
  });

  app.post("/auth/register/email", {
    schema: { tags: ["auth"], body: EmailBody, response: { 201: SessionResponse } },
  }, async (req, reply) => {
    const { email, password } = req.body;
    const session = await svc.registerEmail(email, password, {
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    });
    const accessToken = app.signAccessToken({ sub: session.userId });
    await recordAudit(req, {
      action: "auth.register",
      resourceType: "user",
      resourceId: session.userId,
      actorUserId: session.userId,
    });
    reply.code(201);
    return {
      accessToken,
      refreshToken: session.refreshToken,
      user: { id: session.userId },
    };
  });

  app.post("/auth/refresh", {
    schema: { tags: ["auth"], body: RefreshBody, response: { 200: SessionResponse } },
  }, async (req) => {
    const session = await svc.rotateRefresh(req.body.refreshToken);
    const accessToken = app.signAccessToken({ sub: session.userId });
    return {
      accessToken,
      refreshToken: session.refreshToken,
      user: { id: session.userId },
    };
  });

  app.post("/auth/logout", {
    schema: { tags: ["auth"], body: RefreshBody, response: { 204: z.null() } },
  }, async (req, reply) => {
    await svc.revokeRefresh(req.body.refreshToken);
    reply.code(204);
    return null;
  });
};
