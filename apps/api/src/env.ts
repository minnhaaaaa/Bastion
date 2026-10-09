import { z } from "zod";

const seconds = z.coerce.number().int().positive();

/**
 * All runtime configuration comes from the environment. No defaults are baked in.
 * OPERATOR_TOKENS: comma-separated `user_<id>:<token>` pairs for developer-console operators.
 */
const Env = z.object({
  API_PORT: z.coerce.number().int().positive(),
  WEB_ORIGIN: z.string().url(),
  DATABASE_URL: z.string().url(),
  NEO4J_URI: z.string().min(1),
  NEO4J_USER: z.string().min(1),
  NEO4J_PASSWORD: z.string().min(1),
  LOG_LEVEL: z.enum(["silent", "fatal", "error", "warn", "info", "debug", "trace"]),
  BLOB_DIR: z.string().min(1),
  OPERATOR_TOKENS: z
    .string()
    .min(1)
    .transform((s, ctx) => {
      const map = new Map<string, string>();
      for (const pair of s.split(",").map((p) => p.trim()).filter(Boolean)) {
        const i = pair.indexOf(":");
        const userId = pair.slice(0, i);
        const token = pair.slice(i + 1);
        if (i < 0 || !userId.startsWith("user_") || token.length < 24) {
          ctx.addIssue({ code: "custom", message: "expected user_<id>:<token ≥24 chars>" });
          return z.NEVER;
        }
        map.set(token, userId);
      }
      return map;
    }),
  APPROVAL_TTL_SECONDS: seconds,
  ROOM_TTL_SECONDS: seconds,
  ARENA_BRIEFING_SECONDS: seconds,
  ARENA_ATTACK_WINDOW_SECONDS: seconds,
  /**
   * Explicit choice: "enabled" requires all PI_* / SANDBOX_* / SCHEDULER_* settings and starts the
   * agent runtime; "disabled" serves data only (runs/rooms return 503). No implicit fallback.
   */
  AGENT_RUNTIME: z.enum(["enabled", "disabled"]),
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
