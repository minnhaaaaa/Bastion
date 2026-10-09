import { createHash } from "node:crypto";
import { newId } from "@bastion/contracts";
import type { ArtifactBroker, EventJournal, PolicyRequest, ToolCall, ToolCallResult } from "@bastion/contracts";
import type { DispatchContext, NormalizedCall } from "./index";

export type PendingToolApproval = {
  id: string; actionDigest: string; expiresAt: string; status: "PENDING" | "CONSUMED" | "REJECTED";
  workflowId: string; workflowVersion: number; call: ToolCall; request: PolicyRequest; ruleId: string;
};
/** Implement in Postgres. Raw arguments are private and must never appear in run events. */
export interface ToolApprovalStore {
  insert(record: PendingToolApproval): Promise<void>;
  get(id: string): Promise<PendingToolApproval | null>;
  /** Atomic CAS: pending, matching digest AND expiresAt > now; records the human actor. */
  consume(id: string, digest: string, now: string, actorId: string): Promise<boolean>;
  reject(id: string, digest: string, now: string, actorId: string): Promise<boolean>;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Approval data must be JSON");
  return encoded;
}
export function toolApprovalDigest(record: Omit<PendingToolApproval, "actionDigest" | "status">): string {
  return createHash("sha256").update(canonical(record)).digest("hex");
}

/** Member 2 executor; enabled only after the shared approval events/route/store are approved. */
export class ToolApprovalService {
  constructor(private readonly options: {
    store: ToolApprovalStore; journal: EventJournal; broker: Pick<ArtifactBroker, "isUsable">; ttlMs: number; now(): Date;
    /** Check authenticated human project ownership server-side; never accept an agent identity. */
    authorizeHuman(actorId: string, runId: string): Promise<boolean>;
    pinnedWorkflow(runId: string): Promise<{ id: string; version: number }>;
    context(call: ToolCall): Promise<DispatchContext>;
    normalize(call: ToolCall): Promise<NormalizedCall>;
    execute(call: ToolCall, req: PolicyRequest): Promise<unknown>;
    withExecutionFence<T>(call: ToolCall, operation: () => Promise<T>): Promise<T>;
  }) {
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) throw new Error("Invalid tool approval TTL");
  }
  async request(call: ToolCall, request: PolicyRequest, ruleId: string): Promise<string> {
    if (call.runId !== request.runId || call.executionId !== request.executionId || call.agentId !== request.agentId || call.tool !== request.tool) throw new Error("Approval request identity mismatch");
    const pinned = await this.options.pinnedWorkflow(call.runId);
    const data = structuredClone({ id: newId("approval"), workflowId: pinned.id, workflowVersion: pinned.version, call, request, ruleId, expiresAt: new Date(this.options.now().getTime() + this.options.ttlMs).toISOString() });
    const actionDigest = toolApprovalDigest(data);
    await this.options.store.insert({ ...data, actionDigest, status: "PENDING" });
    return data.id;
  }
  async approve(input: { approvalId: string; actionDigest: string; actorId: string }): Promise<ToolCallResult> {
    const original = await this.options.store.get(input.approvalId);
    if (!original) throw new Error("Tool approval unavailable");
    const record = structuredClone(original);
    const denied = (reason: string): ToolCallResult => ({ status: "DENIED", toolRequestId: record.request.toolRequestId, ruleId: "approval.invalid", reason });
    if (!await this.options.authorizeHuman(input.actorId, record.call.runId)) return denied("Human authorization required");
    return this.options.withExecutionFence(record.call, async () => {
      const { actionDigest, status, ...data } = record;
      const now = this.options.now().toISOString();
      if (status !== "PENDING" || input.actionDigest !== actionDigest || toolApprovalDigest(data) !== actionDigest || now >= record.expiresAt) return denied("Approval expired, consumed or does not match the action");
      const pinned = await this.options.pinnedWorkflow(record.call.runId);
      if (pinned.id !== record.workflowId || pinned.version !== record.workflowVersion) return denied("Pinned workflow changed");
      const current = await this.options.context(record.call);
      const normalized = await this.options.normalize(record.call);
      if (!current.active || current.mode !== "PROTECTED" || current.inputClassification !== record.request.inputClassification || canonical([...current.inputVersionIds].sort()) !== canonical([...record.request.inputVersionIds].sort())) return denied("Execution or consumed inputs changed");
      if (normalized.operation !== record.request.operation || normalized.resource !== record.request.resource || normalized.destination !== record.request.destination) return denied("Normalized target changed");
      const verdict = current.policy.evaluate(record.request);
      if (verdict.decision !== "REQUIRE_APPROVAL" || verdict.ruleId !== record.ruleId) return denied("Policy changed");
      for (const id of record.request.inputVersionIds) if (!await this.options.broker.isUsable(id)) return denied("Input version is unusable");
      // A failed or interrupted execution never makes this approval reusable.
      if (!await this.options.store.consume(record.id, actionDigest, this.options.now().toISOString(), input.actorId)) return denied("Approval expired or already consumed");
      const envelope = { runId: record.call.runId, traceId: record.call.traceId, taskId: record.call.taskId, agentId: record.call.agentId };
      await this.options.journal.append(record.call.runId, [{ ...envelope, type: "tool.decided", payload: { toolRequestId: record.request.toolRequestId, decision: "ALLOW", ruleId: record.ruleId, reason: "Exact tool action approved by an authorized human" } }]);
      let output: unknown;
      try { output = await this.options.execute(record.call, record.request); }
      catch {
        await this.options.journal.append(record.call.runId, [{ ...envelope, type: "tool.executed", payload: { toolRequestId: record.request.toolRequestId, outcome: "ERROR" } }]);
        return denied("Approved execution failed; approval remains consumed");
      }
      await this.options.journal.append(record.call.runId, [{ ...envelope, type: "tool.executed", payload: { toolRequestId: record.request.toolRequestId, outcome: "SUCCESS" } }]);
      return { status: "EXECUTED", toolRequestId: record.request.toolRequestId, output };
    });
  }
  async reject(input: { approvalId: string; actionDigest: string; actorId: string }): Promise<boolean> {
    const record = await this.options.store.get(input.approvalId);
    if (!record || !await this.options.authorizeHuman(input.actorId, record.call.runId)) return false;
    return this.options.store.reject(record.id, input.actionDigest, this.options.now().toISOString(), input.actorId);
  }
}
