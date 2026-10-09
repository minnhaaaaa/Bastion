import { expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, replay, type RunEvent, type WorkflowDefinition } from "@bastion/contracts";
import { SandboxTargetAudit, verifyRun } from "./verification";
import { computeMetrics } from "../metrics";

it("missing independent audit evidence never becomes zero unsafe actions or a verification pass", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastion-audit-evidence-"));
  try {
    const runId = newId("run");
    const snapshot = replay([{ runId, traceId: newId("trace"), eventId: newId("event"), seq: 1, timestamp: new Date().toISOString(), type: "run.created", payload: { projectId: newId("project"), workflowId: newId("workflow"), workflowVersion: 1, mode: "PROTECTED" } } as RunEvent])!;
    const definition: WorkflowDefinition = { name: "audit", agents: [{ id: newId("agent"), role: "BUILDER", capabilities: [] }], sources: [], tasks: [], policyRules: [], attackPayloads: [] };
    definition.tasks.push({ id: newId("task"), agentId: definition.agents[0]!.id, title: "audit", declaredDeps: [], sourceNames: [], produces: "audit", retryPolicy: { maxAttempts: 1, idempotent: true } });
    const auditFile = join(dir, "missing.jsonl");
    const audit = new SandboxTargetAudit(auditFile, async () => snapshot, async () => definition);
    await expect(audit.unsafeAccessCount(runId)).rejects.toThrow();
    expect((await computeMetrics(snapshot, [], audit)).unsafeActionsExecuted).toBeNull();
    expect((await verifyRun(snapshot, audit)).find(check => check.name === "target_audit.no_unsafe_access")).toMatchObject({ passed: false, detail: expect.stringContaining("unavailable") });
    await writeFile(auditFile, "");
    expect((await computeMetrics(snapshot, [], audit)).unsafeActionsExecuted).toBe(0);
    await writeFile(auditFile, "{}\n");
    expect((await computeMetrics(snapshot, [], audit)).unsafeActionsExecuted).toBeNull();
    await writeFile(auditFile, "not a valid audit record\n");
    expect((await computeMetrics(snapshot, [], audit)).unsafeActionsExecuted).toBeNull();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
