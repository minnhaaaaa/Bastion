/** Read-only configuration audit. Prints field names/problems, never environment values. */
import { loadEnv } from "../env";
import { piConfigFromEnv, piModelRegistry } from "@bastion/runtime-pi";
import { sandboxConfigFromEnv } from "@bastion/security";
import { schedulerParallelismFromEnv } from "@bastion/orchestrator";

try { process.loadEnvFile(new URL("../../../../.env", import.meta.url)); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const env = process.env;
const issues: string[] = [];
function present(keys: string[]) {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (!value) issues.push(`${key}: missing`);
    else if (/<[^>]+>|YOUR_|CHANGE_THIS/.test(value)) issues.push(`${key}: contains a placeholder`);
  }
}
present(["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB", "POSTGRES_PORT", "NEO4J_BOLT_PORT", "NEO4J_HTTP_PORT", "API_URL", "VITE_API_URL", "OPERATOR_TOKEN"]);
try { loadEnv(env); } catch (error) { issues.push((error as Error).message); }
for (const key of ["API_URL", "VITE_API_URL"]) {
  if (env[key]?.trim()) {
    try { const url = new URL(env[key]!); if (!["http:", "https:"].includes(url.protocol)) issues.push(`${key}: needs an HTTP(S) URL`); }
    catch { issues.push(`${key}: invalid URL`); }
  }
}
if (env.OPERATOR_TOKEN && env.OPERATOR_TOKENS && !env.OPERATOR_TOKENS.split(",").some(pair => pair.trim().slice(pair.trim().indexOf(":") + 1) === env.OPERATOR_TOKEN)) {
  issues.push("OPERATOR_TOKEN: does not match a configured operator");
}
if (env.AGENT_RUNTIME === "enabled" || process.argv.includes("--runtime")) {
  present(["PI_AUTH_MODE", "PI_PROVIDER", "PI_MODEL", "PI_BASE_URL", "PI_AGENT_DIR", "PI_TIMEOUT_MS", "SCHEDULER_PARALLELISM", "TOOL_APPROVAL_TTL_SECONDS",
    "SANDBOX_NODE_IMAGE", "SANDBOX_URL", "SANDBOX_TOKEN", "SANDBOX_ROOT", "SANDBOX_WORKSPACE_PATH", "SANDBOX_AUDIT_PATH", "SANDBOX_AUDIT_DIRECTORY", "SANDBOX_AUDIT_MOUNT", "SANDBOX_HTTP_ORIGINS", "SANDBOX_EXEC_COMMANDS", "SANDBOX_TOOL_OPERATIONS", "SANDBOX_TIMEOUT_MS", "SANDBOX_MAX_BYTES", "SANDBOX_PORT", "SANDBOX_BIND_HOST", "SANDBOX_PUBLISH_HOST", "SANDBOX_PUBLISH_PORT", "SANDBOX_PIDS_LIMIT", "SANDBOX_MEMORY_LIMIT", "SANDBOX_CPUS"]);
  // Validator errors contain key names only; unexpected errors are redacted.
  if (env.PI_AUTH_MODE === "api-key") present(["PI_API_KEY"]);
  if (env.PI_AUTH_MODE === "oauth") present(["PI_AUTH_FILE"]);
  for (const [name, check] of [
    ["Agent", () => piModelRegistry(piConfigFromEnv(env))],
    ["Sandbox", () => sandboxConfigFromEnv(env)],
    ["Scheduler", () => schedulerParallelismFromEnv(env)],
  ] as const) {
    try { check(); } catch (error) {
      const message = error instanceof Error ? error.message : "";
      issues.push(`${name}: ${/^(Missing |Invalid |PI_|Configured Pi|Codex login|OAuth mode|openai-codex)/.test(message) ? message : "configuration invalid"}`);
    }
  }
  for (const key of ["TOOL_APPROVAL_TTL_SECONDS", "SANDBOX_MAX_BYTES", "SANDBOX_PORT", "SANDBOX_PUBLISH_PORT", "SANDBOX_PIDS_LIMIT"]) {
    if (!Number.isSafeInteger(Number(env[key])) || Number(env[key]) <= 0) issues.push(`${key}: requires a positive integer`);
  }
  for (const key of ["SANDBOX_HTTP_ORIGINS", "SANDBOX_EXEC_COMMANDS"]) {
    try { if (!Array.isArray(JSON.parse(env[key] ?? ""))) throw new Error(); }
    catch { issues.push(`${key}: requires a JSON array`); }
  }
} else {
  console.log("Agent runtime is disabled: model and sandbox settings are not checked; runs/Arena cannot start.");
}
if (issues.length) {
  console.error([...new Set(issues)].join("\n"));
  process.exitCode = 1;
} else console.log("Configuration validation passed. Service connectivity and model access have not been tested.");
