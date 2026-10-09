import { z } from "zod";

/** All runtime configuration comes from the environment. No defaults are baked in. */
const Env = z.object({
  API_PORT: z.coerce.number().int().positive(),
  WEB_ORIGIN: z.string().url(),
  DATABASE_URL: z.string().url(),
  NEO4J_URI: z.string().min(1),
  NEO4J_USER: z.string().min(1),
  NEO4J_PASSWORD: z.string().min(1),
  LOG_LEVEL: z.enum(["silent", "fatal", "error", "warn", "info", "debug", "trace"]),
});
export type Env = z.infer<typeof Env>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`invalid/missing environment variables: ${missing} (see .env.example)`);
  }
  return parsed.data;
}
