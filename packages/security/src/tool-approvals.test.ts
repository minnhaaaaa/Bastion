import { it, expect, vi } from "vitest";
import { newId } from "@bastion/contracts";
import type { PolicyEngine, ToolCall } from "@bastion/contracts";
import { ToolApprovalService, type PendingToolApproval, type ToolApprovalStore } from "./tool-approvals";
import { PolicyToolGateway } from "./index";
import { ExecutionFence } from "../../runtime-adapter/src/index";
import { MemoryBroker, MemoryJournal } from "../../../tests/member2-helpers";

async function setup() {
  let now = new Date();
  const records = new Map<string, PendingToolApproval>();
  const store: ToolApprovalStore = {
    insert: async r => { records.set(r.id, structuredClone(r)); }, get: async id => structuredClone(records.get(id) ?? null),
    consume: async (id, digest, time) => { const r = records.get(id); if (!r || r.status !== "PENDING" || r.actionDigest !== digest || r.expiresAt <= time) return false; r.status = "CONSUMED"; return true; },
    reject: async (id, digest, time) => { const r = records.get(id); if (!r || r.status !== "PENDING" || r.actionDigest !== digest || r.expiresAt <= time) return false; r.status = "REJECTED"; return true; },
  };
  const broker = new MemoryBroker(); const journal = new MemoryJournal(); const fence = new ExecutionFence();
  const human = newId("user");
  const call: ToolCall = { runId: newId("run"), taskId: newId("task"), agentId: newId("agent"), executionId: newId("exec"), traceId: newId("trace"), tool: crypto.randomUUID(), args: { path: crypto.randomUUID() } };
  const source = await broker.ingestSource({ runId: call.runId, name: crypto.randomUUID(), content: crypto.randomUUID(), trust: "TRUSTED", classification: "PUBLIC", traceId: call.traceId });
  const ruleId = crypto.randomUUID();
  const policy: PolicyEngine = { evaluate: () => ({ decision: "REQUIRE_APPROVAL", ruleId, reason: crypto.randomUUID() }) };
  const context = vi.fn(async () => ({ policy, active: true, mode: "PROTECTED" as const, inputClassification: "PUBLIC" as const, inputVersionIds: [source.id] }));
  const normalize = vi.fn(async () => ({ operation: "fs.read", resource: call.args.path as string }));
  const execute = vi.fn(async () => crypto.randomUUID());
  const wf = { id: newId("workflow"), version: 1 };
  const service = new ToolApprovalService({ store, journal, broker, ttlMs: 1000, now: () => now, authorizeHuman: async id => id === human, pinnedWorkflow: async () => wf, context, normalize, execute, withExecutionFence: (call, op) => fence.run(call.executionId, op) });
  const gateway = new PolicyToolGateway({ journal, broker, context, normalize, execute, approvals: service, withExecutionFence: (call, op) => fence.run(call.executionId, op) });
  const pending = await gateway.dispatch(call);
  if (pending.status !== "PENDING_APPROVAL") throw new Error("Missing pending approval");
  const record = records.get(pending.approvalId)!;
  const input = { approvalId: record.id, actionDigest: record.actionDigest, actorId: human };
  return { service, gateway, input, record, records, execute, broker, source, context, normalize, call, wf, journal, expire: () => { now = new Date(now.getTime() + 1001); } };
}

it("returns PENDING_APPROVAL, binds an exact action, and executes once under concurrent approval", async () => {
  const s = await setup(); expect(s.execute).not.toHaveBeenCalled();
  const results = await Promise.all([s.service.approve(s.input), s.service.approve(s.input)]);
  expect(results.map(r => r.status).sort()).toEqual(["DENIED", "EXECUTED"]);
  expect(s.execute).toHaveBeenCalledTimes(1);
  expect(s.record.status).toBe("CONSUMED");
  expect(JSON.stringify(s.journal.events)).not.toContain(s.call.args.path);
});

it("rejects expired, rejected, agent-forged and digest-mismatched approvals", async () => {
  const s = await setup();
  expect((await s.service.approve({ ...s.input, actorId: s.call.agentId })).status).toBe("DENIED");
  expect((await s.service.approve({ ...s.input, actionDigest: crypto.randomUUID() })).status).toBe("DENIED");
  expect(await s.service.reject(s.input)).toBe(true);
  expect((await s.service.approve(s.input)).status).toBe("DENIED");
  const expired = await setup(); expired.expire();
  expect((await expired.service.approve(expired.input)).status).toBe("DENIED");
  expect(s.execute).not.toHaveBeenCalled(); expect(expired.execute).not.toHaveBeenCalled();
});

it("rejects altered private arguments, target renormalization, changed versions and quarantined inputs", async () => {
  const modified = await setup(); modified.record.call.args.path = crypto.randomUUID();
  expect((await modified.service.approve(modified.input)).status).toBe("DENIED");
  const target = await setup(); target.normalize.mockResolvedValue({ operation: "fs.read", resource: crypto.randomUUID() });
  expect((await target.service.approve(target.input)).status).toBe("DENIED");
  const version = await setup(); version.wf.version++;
  expect((await version.service.approve(version.input)).status).toBe("DENIED");
  const quarantine = await setup(); quarantine.broker.unusable.add(quarantine.source.id);
  expect((await quarantine.service.approve(quarantine.input)).status).toBe("DENIED");
  for (const s of [modified, target, version, quarantine]) expect(s.execute).not.toHaveBeenCalled();
});

it("consumes failed executions and never retries the side effect", async () => {
  const s = await setup(); s.execute.mockRejectedValue(new Error("Private failure"));
  expect((await s.service.approve(s.input)).status).toBe("DENIED");
  expect((await s.service.approve(s.input)).status).toBe("DENIED");
  expect(s.execute).toHaveBeenCalledTimes(1);
  expect(s.journal.events.filter(e => e.type === "tool.executed").map(e => e.payload.outcome)).toEqual(["ERROR"]);
});

it("blocks stopped executions and changed input sets before consuming the approval", async () => {
  const stopped = await setup();
  stopped.context.mockResolvedValue({ ...(await stopped.context()), active: false });
  expect((await stopped.service.approve(stopped.input)).status).toBe("DENIED");
  const inputs = await setup();
  inputs.context.mockResolvedValue({ ...(await inputs.context()), inputVersionIds: [newId("source")] });
  expect((await inputs.service.approve(inputs.input)).status).toBe("DENIED");
  expect(stopped.record.status).toBe("PENDING"); expect(inputs.record.status).toBe("PENDING");
  expect(stopped.execute).not.toHaveBeenCalled(); expect(inputs.execute).not.toHaveBeenCalled();
});
