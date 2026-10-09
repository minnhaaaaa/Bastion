import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piAuthStorage, piConfigFromEnv, piModelRegistry, piProviderModels, type PiConfig } from "./index";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const connection = () => ({ PI_PROVIDER: "openrouter", PI_MODEL: "openrouter/free", PI_BASE_URL: "https://openrouter.ai/api/v1", PI_AGENT_DIR: tmpdir(), PI_TIMEOUT_MS: "1000" });
function oauthConfig(): PiConfig & { authMode: "oauth" } {
  const dir = mkdtempSync(join(tmpdir(), "bastion-auth-test-")); directories.push(dir);
  const model = piProviderModels("openai-codex")[0]!;
  return { provider: "openai-codex", model: model.id, baseUrl: model.baseUrl, agentDir: dir, timeoutMs: 1000, authMode: "oauth", authFile: join(dir, "auth.json") };
}

it("API-key mode requires explicit credentials and keeps them in memory", async () => {
  const key = crypto.randomUUID();
  const config = piConfigFromEnv({ ...connection(), PI_AUTH_MODE: "api-key", PI_API_KEY: key });
  expect(config.authMode).toBe("api-key");
  expect(await piAuthStorage(config).getApiKey(config.provider)).toBe(key);
  expect(() => piConfigFromEnv({ ...connection(), PI_AUTH_MODE: "api-key" })).toThrow("PI_API_KEY");
  expect(() => piConfigFromEnv(connection())).toThrow("PI_AUTH_MODE");
});
it("Codex OAuth does not require API credits or an API key", () => {
  const config = oauthConfig();
  expect(piConfigFromEnv({ ...connection(), PI_PROVIDER: "openai-codex", PI_AUTH_MODE: "oauth", PI_AUTH_FILE: config.authFile })).toMatchObject({ authMode: "oauth", authFile: config.authFile });
  expect(() => piAuthStorage(config)).toThrow("Codex login missing");
});
it("OAuth requires Codex, an absolute file path and an OAuth credential", () => {
  expect(() => piConfigFromEnv({ ...connection(), PI_AUTH_MODE: "oauth", PI_AUTH_FILE: join(tmpdir(), "auth.json") })).toThrow("OAuth mode requires");
  expect(() => piConfigFromEnv({ ...connection(), PI_PROVIDER: "openai-codex", PI_AUTH_MODE: "api-key", PI_API_KEY: crypto.randomUUID() })).toThrow("requires PI_AUTH_MODE=oauth");
  expect(() => piConfigFromEnv({ ...connection(), PI_PROVIDER: "openai-codex", PI_AUTH_MODE: "oauth", PI_AUTH_FILE: "relative.json" })).toThrow("absolute path");
  const config = oauthConfig();
  writeFileSync(config.authFile, JSON.stringify({ "openai-codex": { type: "api_key", key: crypto.randomUUID() } }));
  expect(() => piAuthStorage(config)).toThrow("Invalid Codex login");
});
it("subscription credentials cannot be redirected to a custom endpoint", () => {
  const config = oauthConfig();
  writeFileSync(config.authFile, JSON.stringify({ "openai-codex": { type: "oauth", access: crypto.randomUUID(), refresh: crypto.randomUUID(), expires: Date.now() + 60_000 } }));
  expect(piModelRegistry(config).model.id).toBe(config.model);
  expect(() => piModelRegistry({ ...config, baseUrl: "https://example.invalid" })).toThrow("PI_BASE_URL must match");
});
it("Claude uses the installed Anthropic registry and the same runtime", () => {
  const model = piProviderModels("anthropic")[0]!;
  const config = piConfigFromEnv({ ...connection(), PI_PROVIDER: "anthropic", PI_MODEL: model.id, PI_BASE_URL: model.baseUrl, PI_AUTH_MODE: "api-key", PI_API_KEY: crypto.randomUUID() });
  expect(piModelRegistry(config).model.provider).toBe("anthropic");
});
it("missing model fails during setup before any workflow executes", () => {
  const config = piConfigFromEnv({ ...connection(), PI_MODEL: crypto.randomUUID(), PI_AUTH_MODE: "api-key", PI_API_KEY: crypto.randomUUID() });
  expect(() => piModelRegistry(config)).toThrow("Configured Pi model does not exist");
});
