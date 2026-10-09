import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/** The connection string is required configuration — there is no built-in default. */
export function createDb(url: string) {
  const sql = postgres(url, { max: 10 });
  return { db: drizzle(sql, { schema }), sql };
}

export type Db = ReturnType<typeof createDb>["db"];
