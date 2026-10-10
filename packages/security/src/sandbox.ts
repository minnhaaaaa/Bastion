import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, posix, win32 } from "node:path";
import type { PolicyRequest, ToolCall } from "@bastion/contracts";
import type { NormalizedCall } from "./index";

export type SandboxConfig = { url: string; token: string; hostRoot: string; workerRoot: string; timeoutMs: number; toolOperations: Record<string, string> };
export function sandboxConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxConfig {
  const required = (key: string) => { const value = env[key]; if (!value?.trim()) throw new Error(`Missing ${key}`); return value; };
  const url = required("SANDBOX_URL");
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("Invalid sandbox URL");
  const timeoutMs = Number(required("SANDBOX_TIMEOUT_MS"));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid sandbox timeout");
  const toolOperations: unknown = JSON.parse(required("SANDBOX_TOOL_OPERATIONS"));
  if (!toolOperations || typeof toolOperations !== "object" || Array.isArray(toolOperations) || Object.values(toolOperations).some(v => typeof v !== "string")) throw new Error("Invalid tool operation map");
  return { url, token: required("SANDBOX_TOKEN"), hostRoot: required("SANDBOX_WORKSPACE_PATH"), workerRoot: required("SANDBOX_ROOT"), timeoutMs, toolOperations: toolOperations as Record<string, string> };
}

/** Concrete gateway backend. No direct local tool execution or automatic URL redirects. */
export class SandboxClient {
  constructor(private readonly config: SandboxConfig) {}
  async normalize(call: ToolCall): Promise<NormalizedCall> {
    const operation = Object.hasOwn(this.config.toolOperations, call.tool) ? this.config.toolOperations[call.tool] : undefined;
    if (!operation) throw new Error("Unknown tool");
    if (operation === "fs.read" || operation === "fs.write") {
      if (typeof call.args.path !== "string") throw new Error("Missing file path");
      const root = await realpath(this.config.hostRoot);
      const input = call.args.path;
      // Agent paths use the container namespace; resolve them against the mirrored host mount.
      const nativeWorker = win32.isAbsolute(this.config.workerRoot) && !posix.isAbsolute(this.config.workerRoot);
      const rel = nativeWorker && win32.isAbsolute(input) ? win32.relative(this.config.workerRoot, input)
        : posix.isAbsolute(input) ? posix.relative(this.config.workerRoot, input) : input;
      const candidate = resolve(root, rel);
      const check = (path: string) => { const suffix = relative(root, path); if (suffix === ".." || suffix.startsWith("..\\") || suffix.startsWith("../") || isAbsolute(suffix)) throw new Error("Path escapes sandbox"); return suffix; };
      check(candidate);
      let canonical: string;
      try { canonical = await realpath(candidate); }
      catch (error) { if (operation !== "fs.write" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; canonical = resolve(await realpath(dirname(candidate)), relative(dirname(candidate), candidate)); }
      const suffix = check(canonical).replaceAll("\\", "/");
      return { operation, resource: nativeWorker ? win32.resolve(this.config.workerRoot, suffix).replaceAll("\\", "/") : posix.resolve(this.config.workerRoot, suffix) };
    }
    if (operation === "net.http") {
      if (typeof call.args.url !== "string") throw new Error("Missing URL");
      const url = new URL(call.args.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid URL");
      url.hash = "";
      return { operation, resource: url.href, destination: url.origin };
    }
    if (operation === "proc.exec") {
      if (typeof call.args.executable !== "string" || !Array.isArray(call.args.argv) || call.args.argv.some(a => typeof a !== "string")) throw new Error("Invalid process arguments");
      return { operation, resource: JSON.stringify([call.args.executable, ...call.args.argv]) };
    }
    throw new Error("Unsupported operation");
  }
  async execute(call: ToolCall, request: PolicyRequest): Promise<unknown> {
    const response = await fetch(new URL("/dispatch", this.config.url), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(this.config.timeoutMs),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.token}` },
      body: JSON.stringify({ operation: request.operation, resource: request.resource, args: call.args, toolRequestId: request.toolRequestId, executionId: request.executionId }),
    });
    if (!response.ok) throw new Error("Sandbox dispatch failed");
    const result = await response.json() as { output: unknown };
    return result.output;
  }
}
