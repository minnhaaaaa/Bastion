import { createHash } from "node:crypto";
import type { AcceptanceCheck, EventJournal, ToolGateway } from "@bastion/contracts";
import type { ExecutionContext } from "@bastion/orchestrator";

type ToolCheck = Extract<AcceptanceCheck, { kind: "TOOL" }>;

/** Bound to the exact check and execution, so recovery cannot reuse an earlier receipt. */
export function toolCheckReceipt(executionId: string, check: ToolCheck) {
  return `execution.tool:${executionId}:${createHash("sha256").update(JSON.stringify(check)).digest("hex")}`;
}

/** Only the controller invokes this; the model cannot supply arguments or report success. */
export async function executeToolChecks(context: ExecutionContext, checks: ToolCheck[], gateway: ToolGateway, journal: Pick<EventJournal, "append">) {
  let allPassed = true;
  for (const check of checks) {
    let passed = false;
    let detail = "Tool check did not execute successfully";
    try {
      const result = await gateway.dispatch({ runId: context.runId, taskId: context.task.id, agentId: context.task.agentId, executionId: context.executionId, traceId: context.traceId, tool: check.tool, args: structuredClone(check.args) });
      // Sandbox process execution rejects nonzero exits. Dispatch success means the exact
      // configured operation completed, not that arbitrary tool text claims it passed.
      passed = result.status === "EXECUTED";
      detail = result.toolRequestId;
    } catch { /* Record a failed receipt without exposing tool output or provider errors. */ }
    await journal.append(context.runId, [{ runId: context.runId, taskId: context.task.id, agentId: context.task.agentId, traceId: context.traceId, type: "verification.completed", payload: { incidentId: null, checks: [{ name: toolCheckReceipt(context.executionId, check), passed, detail }] } }]);
    allPassed &&= passed;
    if (!passed) break;
  }
  return allPassed;
}
