import { it, expect, vi } from "vitest";
import { newId, replay } from "@bastion/contracts";
import type { ToolCall } from "@bastion/contracts";
import { verifySelectedClaims, verifyToolAcceptanceChecks } from "./verification";
import { MemoryJournal } from "../../../tests/member2-helpers";

async function setup() {
  const journal = new MemoryJournal();
  const runId = newId("run"), taskId = newId("task"), agentId = newId("agent"), executionId = newId("exec"), sourceId = newId("source"), artifactId = newId("artifact"), traceId = newId("trace");
  const envelope = { runId, traceId };
  await journal.append(runId, [
    { ...envelope, type: "run.created", payload: { projectId: newId("project"), workflowId: newId("workflow"), workflowVersion: 1, mode: "PROTECTED" } },
    { ...envelope, type: "source.ingested", payload: { sourceVersionId: sourceId, name: crypto.randomUUID(), version: 1, contentHash: crypto.randomUUID(), trust: "TRUSTED", classification: "PUBLIC", blobRef: crypto.randomUUID(), preview: "" } },
    { ...envelope, type: "run.planned", payload: { tasks: [{ taskId, agentId, role: "VERIFIER", title: crypto.randomUUID(), declaredDeps: [], sourceIds: [sourceId], retryPolicy: { maxAttempts: 1, idempotent: true } }] } },
    { ...envelope, type: "task.state_changed", payload: { taskId, executionId, attempt: 1, from: "PENDING", to: "RUNNING" } },
    { ...envelope, type: "artifact.consumed", payload: { inputVersionId: sourceId, consumerExecutionId: executionId, consumerTaskId: taskId } },
    { ...envelope, type: "artifact.published", payload: { artifactVersionId: artifactId, name: crypto.randomUUID(), version: 1, contentHash: crypto.randomUUID(), sourceIds: [sourceId], derivedFrom: [], producerExecutionId: executionId, producerTaskId: taskId, classification: "PUBLIC", trustState: "CLEAR", blobRef: crypto.randomUUID(), preview: "" } },
  ]);
  const snapshot = replay(await journal.read(runId));
  return { journal, snapshot, runId, taskId, agentId, executionId, sourceId, artifactId, traceId };
}

it("checks quotations only against trusted, observed sources and journals redacted unsupported claims", async () => {
  const s = await setup(); const quote = crypto.randomUUID(); const unsupported = crypto.randomUUID();
  const readVersion = vi.fn(async (_id: string) => quote);
  const checks = await verifySelectedClaims({ ...s, claims: [{ artifactVersionId: s.artifactId, text: quote, sourceVersionIds: [s.sourceId] }, { artifactVersionId: s.artifactId, text: unsupported, sourceVersionIds: [s.sourceId] }], readVersion, preview: () => "[redacted]" });
  expect(checks.map(c => c.passed)).toEqual([true, false]);
  const events = s.journal.events.filter(e => e.type === "claim.unverified");
  expect(events).toHaveLength(1); expect(events[0]!.payload.claim).toBe("[redacted]");
  expect(JSON.stringify(events)).not.toContain(unsupported);
});

it("rejects unobserved or quarantined evidence without reading it", async () => {
  const s = await setup(); s.snapshot.sources[s.sourceId]!.securityState = "QUARANTINED";
  const readVersion = vi.fn(async (_id: string) => "quote");
  const checks = await verifySelectedClaims({ ...s, claims: [{ artifactVersionId: s.artifactId, text: "quote", sourceVersionIds: [s.sourceId] }], readVersion, preview: () => "[redacted]" });
  expect(checks[0]!.passed).toBe(false);
  expect(readVersion.mock.calls).toEqual([[s.artifactId]]);
  await expect(verifySelectedClaims({ ...s, claims: [{ artifactVersionId: newId("artifact"), text: "quote", sourceVersionIds: [] }], readVersion, preview: () => "" })).rejects.toThrow("owned");
});

it("routes acceptance commands through the gateway and fails pending or denied checks", async () => {
  const s = await setup();
  const call: ToolCall = { runId: s.runId, taskId: s.taskId, executionId: s.executionId, agentId: s.agentId, traceId: s.traceId, tool: crypto.randomUUID(), args: { executable: crypto.randomUUID(), argv: [] } };
  const dispatch = vi.fn(async () => ({ status: "DENIED" as const, toolRequestId: newId("tool"), ruleId: "default.deny", reason: "Generated denial" }));
  expect((await verifyToolAcceptanceChecks({ ...s, checks: [{ id: crypto.randomUUID(), call, expectedExit: "SUCCESS" }], gateway: { dispatch } }))[0]!.passed).toBe(false);
  expect(dispatch).toHaveBeenCalledOnce();
  s.snapshot.executions[s.executionId]!.state = "SUCCEEDED";
  await expect(verifyToolAcceptanceChecks({ ...s, checks: [{ id: crypto.randomUUID(), call, expectedExit: "SUCCESS" }], gateway: { dispatch } })).rejects.toThrow("active verifier");
});
