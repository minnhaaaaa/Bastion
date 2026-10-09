import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import * as schema from "./schema";

/** Any Drizzle Postgres database with our schema (postgres-js in prod, PGlite in tests). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

/** The connection string is required configuration — there is no built-in default. */
export function createDb(url: string) {
  const sql = postgres(url, { max: 10 });
  const db = drizzle(sql, { schema }) as unknown as Db;
  return {
    db,
    sql,
    migrate: () => migrate(drizzle(sql, { schema }), { migrationsFolder: MIGRATIONS_DIR }),
    close: () => sql.end(),
  };
}
