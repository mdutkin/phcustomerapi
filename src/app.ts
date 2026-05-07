// Build the Fastify app. `server.ts` (entry) calls this and listens.
// Tests build the app and call `inject` against it directly.

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import sensible from "@fastify/sensible";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { env, isProd } from "@/config/env";
import authPlugin from "@/plugins/auth";
import errorHandler from "@/plugins/error-handler";
import { authRoutes } from "@/modules/auth/auth.routes";
import { patientRoutes } from "@/modules/patients/patients.routes";
import { prescriptionRoutes } from "@/modules/prescriptions/prescriptions.routes";
import { labRoutes } from "@/modules/labs/labs.routes";
import { shopRoutes } from "@/modules/shop/shop.routes";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport: isProd ? undefined : { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } },
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", "*.password", "*.passwordHash", "*.refreshToken", "*.token"],
        censor: "[redacted]",
      },
    },
    disableRequestLogging: false,
    bodyLimit: 1_048_576, // 1 MiB
    trustProxy: true,
    genReqId: () => crypto.randomUUID(),
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(sensible);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: env.CORS_ORIGINS.length === 0 ? false : env.CORS_ORIGINS,
    credentials: true,
  });
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
  });

  await app.register(errorHandler);
  await app.register(authPlugin);

  await app.register(swagger, {
    openapi: {
      info: {
        title: "phcustomerapi",
        description: "Customer-facing API for Medico Pharmacy / CCCHC patient portal and mobile app.",
        version: "0.1.0",
      },
      servers: [{ url: `http://localhost:${env.PORT}` }],
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  // Health check — no auth, no rate limit, used by load balancers.
  app.get("/health", { config: { rateLimit: false } }, async () => ({
    ok: true,
    service: "phcustomerapi",
    version: "0.1.0",
    env: env.NODE_ENV,
    time: new Date().toISOString(),
  }));

  await app.register(authRoutes);
  await app.register(patientRoutes);
  await app.register(prescriptionRoutes);
  await app.register(labRoutes);
  await app.register(shopRoutes);

  return app;
}
