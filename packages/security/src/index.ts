/**
 * @bastion/security — owner: Member 2
 * Deterministic PolicyEngine + ToolGateway + redaction. Default deny; fail closed.
 * See TEAM_PLAN.md and packages/contracts/src/ports.ts.
 */
import { createHash } from "node:crypto";
import { PolicyRequest, WorkflowDefinition, newId } from "@bastion/contracts";
import type { ArtifactBroker, EventJournal, PolicyEngine, PolicyResult, ToolCall, ToolCallResult, ToolGateway } from "@bastion/contracts";
export { SandboxClient, sandboxConfigFromEnv } from "./sandbox";
export type { SandboxConfig } from "./sandbox";
export { ToolApprovalService, toolApprovalDigest } from "./tool-approvals";
export type { PendingToolApproval, ToolApprovalStore } from "./tool-approvals";

/** Anchored glob: * cannot cross a path separator; ** can. */
export function matches(pattern: string, resource: string): boolean {
  let expression = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") { expression += ".*"; i++; }
      else expression += "[^/]*";
    } else if (c === "?") expression += "[^/]";
    else expression += c.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(expression + "$").test(resource);
}

export class WorkflowPolicyEngine implements PolicyEngine {
  private readonly workflow: WorkflowDefinition;
  constructor(definition: WorkflowDefinition) { this.workflow = WorkflowDefinition.parse(definition); }
  evaluate(request: PolicyRequest): PolicyResult {
    const req = PolicyRequest.parse(request);
    const agent = this.workflow.agents.find(a => a.id === req.agentId);
    const granted = agent?.capabilities.some(capability => {
      const colon = capability.indexOf(":");
      const resource = req.operation === "net.http" ? new URL(req.resource).hostname : req.resource;
      return capability.slice(0, colon) === req.operation && matches(capability.slice(colon + 1), resource);
    });
    if (!granted) return { decision: "DENY", ruleId: "default.deny", reason: "Agent capability does not grant this operation" };
    const rules = this.workflow.policyRules.filter(r => r.operation === req.operation && matches(r.resourcePattern, req.resource));
    const rule = rules.find(r => r.decision === "DENY") ?? rules.find(r => r.decision === "REQUIRE_APPROVAL") ?? rules.find(r => r.decision === "ALLOW");
    return rule ? { decision: rule.decision, ruleId: rule.id, reason: rule.description } : { decision: "DENY", ruleId: "default.deny", reason: "No workflow policy grants this operation" };
  }
}

export type DispatchContext = {
  policy: PolicyEngine;
  inputClassification: PolicyRequest["inputClassification"];
  inputVersionIds: string[];
  active: boolean;
  mode: "PROTECTED" | "BASELINE";
};
export type NormalizedCall = Pick<PolicyRequest, "operation" | "resource" | "destination">;
export type GatewayOptions = {
  journal: EventJournal;
  broker: Pick<ArtifactBroker, "isUsable">;
  /** Load authoritative execution ownership, current grants and consumed inputs. */
  context(call: ToolCall): Promise<DispatchContext>;
  normalize(call: ToolCall): Promise<NormalizedCall>;
  execute(call: ToolCall, request: PolicyRequest): Promise<unknown>;
  /** A durable pending store, supplied only after approval lifecycle/REST contracts are agreed. */
  approvals?: { request(call: ToolCall, request: PolicyRequest, ruleId: string): Promise<string> };
  /** Quarantine/hold must share this lock with dispatch. */
  withExecutionFence<T>(call: ToolCall, dispatch: () => Promise<T>): Promise<T>;
};

export class PolicyToolGateway implements ToolGateway {
  constructor(private readonly options: GatewayOptions) {}
  async dispatch(original: ToolCall): Promise<ToolCallResult> {
    const call = structuredClone(original);
    const toolRequestId = newId("tool");
    let requested = false;
    let attempted = false;
    const envelope = { runId: call.runId, taskId: call.taskId, agentId: call.agentId, traceId: call.traceId };
    const deny = async (ruleId: string, reason: string): Promise<ToolCallResult> => {
      // Once execution was attempted, preserve its original decision and ERROR outcome.
      // A later DENY event would incorrectly reduce the call to NOT_EXECUTED.
      if (requested && !attempted) {
        await this.options.journal.append(call.runId, [
          { ...envelope, type: "tool.decided", payload: { toolRequestId, decision: "DENY", ruleId, reason } },
          ...(!attempted ? [{ ...envelope, type: "tool.executed" as const, payload: { toolRequestId, outcome: "NOT_EXECUTED" as const } }] : []),
        ]);
      }
      return { status: "DENIED", toolRequestId, ruleId, reason };
    };
    try {
      return await this.options.withExecutionFence(call, async () => {
        const normalized = await this.options.normalize(call);
        const context = await this.options.context(call);
        const request = PolicyRequest.parse({ ...normalized, ...context, runId: call.runId, agentId: call.agentId, executionId: call.executionId, toolRequestId, tool: call.tool });
        await this.options.journal.append(call.runId, [{ ...envelope, type: "tool.requested", payload: {
          toolRequestId, executionId: call.executionId, agentId: call.agentId, tool: call.tool,
          // Commands and URL paths can contain secret input content. Journal a stable identity,
          // never raw arguments; policy evaluation and target-side audit retain the real resource.
          operation: request.operation, resource: createHash("sha256").update(request.resource).digest("hex"), destination: request.destination ? new URL(request.destination).origin : null,
          argsHash: createHash("sha256").update(JSON.stringify(call.args)).digest("hex"),
        } }]);
        requested = true;
        if (!context.active) return deny("default.deny", "Execution is inactive");
        const evaluate = (ctx: DispatchContext, req: PolicyRequest): PolicyResult => ctx.mode === "BASELINE"
          ? { decision: "ALLOW", ruleId: "baseline.unprotected", reason: "Pinned baseline comparison bypasses workflow policy" }
          : ctx.policy.evaluate(req);
        const decision = evaluate(context, request);
        await this.options.journal.append(call.runId, [{ ...envelope, type: "tool.decided", payload: { toolRequestId, ...decision } }]);
        if (decision.decision === "REQUIRE_APPROVAL" && this.options.approvals) {
          const approvalId = await this.options.approvals.request(call, request, decision.ruleId);
          return { status: "PENDING_APPROVAL", toolRequestId, approvalId };
        }
        if (decision.decision !== "ALLOW") {
          await this.options.journal.append(call.runId, [{ ...envelope, type: "tool.executed", payload: { toolRequestId, outcome: "NOT_EXECUTED" } }]);
          return { status: "DENIED", toolRequestId, ruleId: decision.ruleId, reason: decision.reason };
        }
        const current = await this.options.context(call);
        if (!current.active || current.inputVersionIds.join("\0") !== request.inputVersionIds.join("\0")) return deny("default.deny", "Execution stopped or inputs changed");
        if (current.mode !== context.mode) return deny("default.deny", "Run mode changed");
        const recheck = evaluate(current, { ...request, inputClassification: current.inputClassification });
        if (recheck.decision !== "ALLOW") return deny(recheck.ruleId, recheck.reason);
        for (const id of current.inputVersionIds) if (!await this.options.broker.isUsable(id)) return deny("default.deny", "Input version is unusable");
        let output: unknown;
        try { attempted = true; output = await this.options.execute(call, request); }
        catch { await this.options.journal.append(call.runId, [{ ...envelope, type: "tool.executed", payload: { toolRequestId, outcome: "ERROR" } }]); throw new Error("Tool execution failed"); }
        await this.options.journal.append(call.runId, [{ ...envelope, type: "tool.executed", payload: { toolRequestId, outcome: "SUCCESS" } }]);
        return { status: "EXECUTED", toolRequestId, output };
      });
    } catch {
      await this.options.journal.append(call.runId, [{ ...envelope, type: "policy.unavailable", payload: { toolRequestId, reason: "Dispatch failed closed" } }]);
      return deny("policy.unavailable", "Dispatch failed closed");
    }
  }
}
