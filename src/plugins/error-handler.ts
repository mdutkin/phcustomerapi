// Single source of truth for HTTP error responses. Hides internal details in
// production but surfaces the message in dev/test.

import fp from "fastify-plugin";
import { ZodError } from "zod";
import { isProd } from "@/config/env";

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message?: string,
    public details?: unknown,
  ) {
    super(message ?? code);
  }
}

export default fp(async (app) => {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: "validation_error",
        issues: err.flatten(),
      });
    }
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({
        error: err.code,
        message: err.message,
        details: err.details,
      });
    }

    const e = err as { statusCode?: number; code?: string; message?: string };
    const statusCode = typeof e.statusCode === "number" && e.statusCode >= 400 ? e.statusCode : 500;
    if (statusCode >= 500) req.log.error({ err }, "unhandled error");

    reply.code(statusCode).send({
      error: statusCode >= 500 ? "internal_error" : (e.code ?? "error"),
      message: isProd && statusCode >= 500 ? "Internal server error" : e.message,
    });
  });
}, { name: "error-handler" });
