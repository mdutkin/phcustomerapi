// Registers @fastify/jwt and exposes:
//   - app.authenticate decorator (preHandler) — verifies the access token
//   - request.user — typed JWT payload
//   - app.signAccessToken / app.signRefreshToken helpers

import fp from "fastify-plugin";
import jwtPlugin, { type FastifyJWT } from "@fastify/jwt";
import { env } from "@/config/env";

export interface AccessTokenPayload {
  sub: string;          // portal user id
  // Patient linkage is fetched per-request from PG (`user_patients`),
  // not encoded in the token. Keeps tokens stable as links change.
  type: "access";
}
export interface RefreshTokenPayload {
  sub: string;
  jti: string;
  type: "refresh";
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AccessTokenPayload | RefreshTokenPayload;
    user: AccessTokenPayload;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => Promise<void>;
    signAccessToken: (p: Omit<AccessTokenPayload, "type">) => string;
    signRefreshToken: (p: Omit<RefreshTokenPayload, "type">) => string;
  }
}

export default fp(async (app) => {
  await app.register(jwtPlugin, {
    secret: env.JWT_SECRET,
    sign: { iss: env.JWT_ISSUER },
    verify: { allowedIss: env.JWT_ISSUER },
  });

  app.decorate("authenticate", async function (req, reply) {
    try {
      await req.jwtVerify();
      const payload = req.user as unknown as FastifyJWT["payload"];
      if (payload.type !== "access") {
        return reply.code(401).send({ error: "invalid_token_type" });
      }
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.decorate("signAccessToken", function (this: typeof app, p) {
    return this.jwt.sign({ ...p, type: "access" } satisfies AccessTokenPayload, {
      expiresIn: env.JWT_ACCESS_TTL,
    });
  });

  app.decorate("signRefreshToken", function (this: typeof app, p) {
    return this.jwt.sign({ ...p, type: "refresh" } satisfies RefreshTokenPayload, {
      expiresIn: env.JWT_REFRESH_TTL,
    });
  });
}, { name: "auth-jwt" });
