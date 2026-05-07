// Process entry. Builds the app, listens, handles graceful shutdown.

import { buildApp } from "./app";
import { env } from "@/config/env";
import { pool } from "@/db/client";

async function main() {
  const app = await buildApp();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutdown initiated");
    try {
      await app.close();
      await pool.end();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "shutdown error");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    app.log.error({ reason }, "unhandledRejection");
  });

  try {
    await app.listen({ host: env.HOST, port: env.PORT });
    app.log.info(`📚 Docs: http://localhost:${env.PORT}/docs`);
  } catch (err) {
    app.log.error({ err }, "failed to start");
    process.exit(1);
  }
}

void main();
