import { expect, it } from "vitest";
import { newId, type ToolApprovalView } from "../packages/contracts/src";
import { canResolveAction, reviewedDecision, type ReviewedAction } from "../apps/web/src/lib/tool-review";

function pending() {
  const now = Date.now();
  const approval: ToolApprovalView = { id: newId("toolApproval"), runId: newId("run"), executionId: newId("exec"), toolRequestId: newId("tool"), actionDigest: crypto.randomUUID(), expiresAt: new Date(now + 60000).toISOString(), status: "PENDING", operation: "fs.write", resourcePreview: "/workspace/output/report.md", actorId: null, reason: null };
  const exact: ReviewedAction = { ...approval, resource: approval.resourcePreview, destination: null, args: { content: "reviewed output" }, ruleId: crypto.randomUUID(), agentId: newId("agent"), taskId: newId("task") };
  return { now, approval, exact };
}

it("requires operator-only exact details before enabling a decision", () => {
  const { approval, now } = pending(); expect(canResolveAction(approval, undefined, now)).toBe(false);
});
it("binds allow/deny to the action actually reviewed", () => {
  const { approval, exact, now } = pending();
  for (const decision of ["APPROVE", "REJECT"] as const) {
    expect(reviewedDecision(approval, exact, decision, now)).toMatchObject({ toolRequestId: exact.toolRequestId, actionDigest: exact.actionDigest, decision });
  }
  for (const changed of [{ ...exact, actionDigest: crypto.randomUUID() }, { ...exact, id: newId("toolApproval") }, { ...exact, toolRequestId: newId("tool") }]) {
    expect(() => reviewedDecision(approval, changed, "APPROVE", now)).toThrow(/changed or expired/);
  }
});
it("blocks expired, rejected and consumed approvals even if the last render enabled the button", () => {
  const { approval, exact, now } = pending();
  expect(() => reviewedDecision(approval, exact, "APPROVE", now + 60000)).toThrow();
  for (const status of ["REJECTED", "EXPIRED", "CANCELLED", "CONSUMED"] as const) {
    expect(canResolveAction({ ...approval, status }, exact, now)).toBe(false);
    expect(canResolveAction(approval, { ...exact, status }, now)).toBe(false);
  }
  expect(canResolveAction(approval, { ...exact, expiresAt: "invalid" }, now)).toBe(false);
});
