// Postgres pool + Drizzle client. Single instance, shared across modules.

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "@/config/env";
import * as schema from "./schema";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export const db = drizzle(pool, { schema });
export type Db = typeof db;
export { schema };
