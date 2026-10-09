import { newId, type ToolApprovalView } from "@bastion/contracts";

export type ReviewedAction = Pick<ToolApprovalView, "id" | "status" | "actionDigest" | "expiresAt" | "toolRequestId" | "operation"> & {
  resource: string; destination: string | null; args: Record<string, unknown>; ruleId: string; agentId: string; taskId: string;
};

export function canResolveAction(approval: ToolApprovalView, exact: ReviewedAction | undefined, now: number) {
  return !!exact && approval.status === "PENDING" && exact.status === "PENDING"
    && approval.id === exact.id && approval.toolRequestId === exact.toolRequestId
    && approval.actionDigest === exact.actionDigest
    && Date.parse(approval.expiresAt) > now && Date.parse(exact.expiresAt) > now;
}

export function reviewedDecision(approval: ToolApprovalView, exact: ReviewedAction, decision: "APPROVE" | "REJECT", now: number) {
  if (!canResolveAction(approval, exact, now)) throw new Error("This action has changed or expired. Refresh its details before deciding.");
  return { commandId: newId("command"), toolRequestId: exact.toolRequestId, actionDigest: exact.actionDigest, decision };
}
