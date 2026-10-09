import { it, expect } from "vitest";
import { fork } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { Type } from "@sinclair/typebox";
import { newId } from "@bastion/contracts";
import type { ToolCall, WorkflowDefinition } from "@bastion/contracts";
import { gatewayTools } from "./index";
import { PolicyToolGateway, WorkflowPolicyEngine, SandboxClient } from "../../security/src/index";
import { MemoryBroker, MemoryJournal } from "../../../tests/member2-helpers";

it("gateway-backed Pi tool denial leaves the REAL worker access audit empty", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bastion-audit-"));
  const file = join(directory, crypto.randomUUID()); const audit = join(directory, crypto.randomUUID());
  await writeFile(file, crypto.randomUUID()); await writeFile(audit, "");
  const canonicalFile = await realpath(file);
  const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const token = crypto.randomUUID();
  const worker = fork(resolve("sandbox/worker.mjs"), [], { silent: true, env: {
    ...process.env, SANDBOX_ROOT: directory, SANDBOX_AUDIT_PATH: audit, SANDBOX_TOKEN: token,
    SANDBOX_HTTP_ORIGINS: "[]", SANDBOX_EXEC_COMMANDS: "[]", SANDBOX_TIMEOUT_MS: "1000", SANDBOX_MAX_BYTES: "65536", SANDBOX_PORT: String(port), SANDBOX_BIND_HOST: "127.0.0.1",
  } });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Worker startup timed out")), 5000);
      worker.once("message", () => { clearTimeout(timer); resolve(); });
      worker.once("exit", () => { clearTimeout(timer); reject(new Error("Worker exited")); });
    });
    const call: ToolCall = { runId: newId("run"), taskId: newId("task"), agentId: newId("agent"), executionId: newId("exec"), traceId: newId("trace"), tool: crypto.randomUUID(), args: { path: file } };
    const definition: WorkflowDefinition = { name: crypto.randomUUID(), agents: [{ id: call.agentId, role: "RESEARCH", capabilities: [] }], tasks: [{ id: call.taskId, agentId: call.agentId, title: crypto.randomUUID(), declaredDeps: [], sourceNames: [], produces: crypto.randomUUID(), retryPolicy: { maxAttempts: 1, idempotent: true } }], sources: [], attackPayloads: [], policyRules: [] };
    const client = new SandboxClient({ url: `http://127.0.0.1:${port}`, token, hostRoot: directory, workerRoot: "/workspace", timeoutMs: 1000, toolOperations: { [call.tool]: "fs.read" } });
    let mode: "PROTECTED" | "BASELINE" = "PROTECTED";
    const journal = new MemoryJournal();
    const gateway = new PolicyToolGateway({ journal, broker: new MemoryBroker(), context: async () => ({ policy: new WorkflowPolicyEngine(definition), mode, active: true, inputClassification: "PUBLIC", inputVersionIds: [] }), normalize: async () => ({ operation: "fs.read", resource: canonicalFile }), execute: (call, req) => client.execute(call, req), withExecutionFence: async (_call, dispatch) => dispatch() });
    const [tool] = gatewayTools([{ name: call.tool, label: call.tool, description: crypto.randomUUID(), parameters: Type.Object({ path: Type.String() }) }], gateway, call);
    const result = await tool!.execute(crypto.randomUUID(), call.args, undefined, undefined, {} as never);
    expect(result.details).toEqual({ status: "DENIED" });
    expect(await readFile(audit, "utf8")).toBe("");
    // Positive control proves audit instrumentation records a real access.
    mode = "BASELINE";
    const baseline = await tool!.execute(crypto.randomUUID(), call.args, undefined, undefined, {} as never);
    expect(baseline.details, JSON.stringify(baseline)).toEqual({ status: "EXECUTED" });
    const entries = (await readFile(audit, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ operation: "fs.read", executionId: call.executionId });
  } finally {
    if (worker.exitCode === null) { const exit = new Promise<void>(resolve => worker.once("exit", () => resolve())); worker.kill(); await exit; }
    const rel = relative(await realpath(tmpdir()), await realpath(directory));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe cleanup path");
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
