import { and, eq, lte } from "drizzle-orm";
import { newId, type NewRunEvent, type PolicyRequest, type RunEvent, type ToolCallResult, type ToolGateway } from "@bastion/contracts";
import { schema, toIso, type Db } from "@bastion/db";
import { redactPreview } from "@bastion/provenance";
import type { PendingToolApproval, ToolApprovalService, ToolApprovalStore } from "@bastion/security";
import { HttpError, notFound } from "./errors";

type Journal = {
  append(runId: string, events: NewRunEvent[]): Promise<RunEvent[]>;
  onCommitted(listener: (e: RunEvent) => void | Promise<void>): () => void;
};
type FinalStatus = "CONSUMED" | "REJECTED" | "EXPIRED" | "CANCELLED";

/** Public preview of a target: never query strings, arguments or file contents. */
export function resourcePreview(req: Pick<PolicyRequest, "operation" | "resource">): string {
  try {
    if (req.operation === "net.http") {
      const u = new URL(req.resource);
      return redactPreview(`${u.origin}${u.pathname}`);
    }
    if (req.operation === "proc.exec") return redactPreview(String((JSON.parse(req.resource) as unknown[])[0] ?? ""));
  } catch {
    return "[unparseable target]";
  }
  return redactPreview(req.resource);
}

const toRecord = (r: typeof schema.toolApprovals.$inferSelect): PendingToolApproval => ({
  ...(r.record as PendingToolApproval),
  // Columns are authoritative for lifecycle fields.
  status: r.status,
  actionDigest: r.actionDigest,
  expiresAt: toIso(r.expiresAt),
});

/**
 * Postgres ToolApprovalStore (CONTRACT_PROPOSAL B3). Every status change is a compare-and-set from
 * PENDING, so an approval resolves exactly once; each transition is journaled with a redacted preview.
 */
export class PgToolApprovalStore implements ToolApprovalStore {
  constructor(
    private readonly db: Db,
    private readonly journal: Journal,
  ) {}

  async insert(record: PendingToolApproval): Promise<void> {
    await this.db.insert(schema.toolApprovals).values({
      id: record.id,
      runId: record.call.runId,
      executionId: record.call.executionId,
      toolRequestId: record.request.toolRequestId,
      status: "PENDING",
      actionDigest: record.actionDigest,
      expiresAt: record.expiresAt,
      record,
    });
    const c = record.call;
    await this.journal.append(c.runId, [
      {
        runId: c.runId,
        traceId: c.traceId,
        taskId: c.taskId,
        agentId: c.agentId,
        type: "tool.approval_requested",
        payload: {
          approvalId: record.id,
          toolRequestId: record.request.toolRequestId,
          executionId: c.executionId,
          actionDigest: record.actionDigest,
          expiresAt: record.expiresAt,
          operation: record.request.operation,
          resourcePreview: resourcePreview(record.request),
        },
      },
    ]);
  }

  async get(id: string): Promise<PendingToolApproval | null> {
    const [r] = await this.db.select().from(schema.toolApprovals).where(eq(schema.toolApprovals.id, id));
    return r ? toRecord(r) : null;
  }

  async runOf(id: string): Promise<string | null> {
    const [r] = await this.db.select({ runId: schema.toolApprovals.runId }).from(schema.toolApprovals).where(eq(schema.toolApprovals.id, id));
    return r?.runId ?? null;
  }

  async pending(runId: string): Promise<PendingToolApproval[]> {
    const rows = await this.db
      .select()
      .from(schema.toolApprovals)
      .where(and(eq(schema.toolApprovals.runId, runId), eq(schema.toolApprovals.status, "PENDING")));
    return rows.map(toRecord);
  }

  /** CAS PENDING → status. Human transitions require a matching digest and an unexpired approval. */
  private async transition(
    id: string,
    to: FinalStatus,
    actorId: string,
    reason: string,
    guard?: { digest: string; now: string },
  ): Promise<boolean> {
    const conds = [eq(schema.toolApprovals.id, id), eq(schema.toolApprovals.status, "PENDING")];
    if (guard) conds.push(eq(schema.toolApprovals.actionDigest, guard.digest));
    const rows = await this.db
      .update(schema.toolApprovals)
      .set({ status: to, actorId, reason, resolvedAt: new Date().toISOString() })
      .where(and(...conds))
      .returning();
    const r = rows[0];
    if (!r) return false;
    if (guard && Date.parse(toIso(r.expiresAt)) <= Date.parse(guard.now)) {
      // Expired between read and write: undo into EXPIRED rather than honouring a stale approval.
      await this.db.update(schema.toolApprovals).set({ status: "EXPIRED", reason: "approval window elapsed" }).where(eq(schema.toolApprovals.id, id));
      await this.journalResolution(toRecord({ ...r, status: "EXPIRED" }), "EXPIRED", "system", "approval window elapsed");
      return false;
    }
    await this.journalResolution(toRecord(r), to, actorId, reason);
    return true;
  }

  private async journalResolution(rec: PendingToolApproval, status: FinalStatus, actorId: string, reason: string) {
    const c = rec.call;
    const env = { runId: c.runId, traceId: c.traceId, taskId: c.taskId, agentId: c.agentId };
    const toolRequestId = rec.request.toolRequestId;
    await this.journal.append(c.runId, [
      { ...env, type: "tool.approval_resolved", payload: { approvalId: rec.id, toolRequestId, status, actorId, reason } },
      // Not executed unless consumed; the executor records the real outcome for CONSUMED.
      ...(status === "CONSUMED" ? [] : [{ ...env, type: "tool.executed" as const, payload: { toolRequestId, outcome: "NOT_EXECUTED" as const } }]),
    ]);
  }

  consume(id: string, digest: string, now: string, actorId: string) {
    return this.transition(id, "CONSUMED", actorId, "approved by an authorized human", { digest, now });
  }

  reject(id: string, digest: string, now: string, actorId: string) {
    return this.transition(id, "REJECTED", actorId, "rejected by an authorized human", { digest, now });
  }

  /** System transitions (no digest): expiry, cancellation, restart. */
  close(id: string, status: "EXPIRED" | "CANCELLED", reason: string) {
    return this.transition(id, status, "system", reason);
  }

  /** Boot: nothing can be waiting on a pending approval after a restart. */
  async expireAll(reason: string): Promise<string[]> {
    const rows = await this.db.select({ id: schema.toolApprovals.id }).from(schema.toolApprovals).where(eq(schema.toolApprovals.status, "PENDING"));
    const done: string[] = [];
    for (const { id } of rows) if (await this.close(id, "EXPIRED", reason)) done.push(id);
    return done;
  }

  async expireDue(nowIso: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: schema.toolApprovals.id })
      .from(schema.toolApprovals)
      .where(and(eq(schema.toolApprovals.status, "PENDING"), lte(schema.toolApprovals.expiresAt, nowIso)));
    const done: string[] = [];
    for (const { id } of rows) if (await this.close(id, "EXPIRED", "approval window elapsed")) done.push(id);
    return done;
  }
}

type Waiter = { resolve: (r: ToolCallResult) => void; timer: NodeJS.Timeout };
const denied = (toolRequestId: string, ruleId: string, reason: string): ToolCallResult => ({ status: "DENIED", toolRequestId, ruleId, reason });

/**
 * Runtime side of tool approvals: suspends the agent's tool call (outside the execution fence) until
 * a human resolves it, then hands the real result back to that same call. Expiry, execution stop and
 * input quarantine cancel the wait.
 */
export class ToolApprovalCoordinator {
  private readonly waiters = new Map<string, Waiter>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly store: PgToolApprovalStore,
    private readonly service: ToolApprovalService,
    journal: Journal,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.unsubscribe = journal.onCommitted((e) => this.onEvent(e));
  }

  stop() {
    this.unsubscribe();
    for (const w of this.waiters.values()) clearTimeout(w.timer);
    this.waiters.clear();
  }

  /** Gateway handed to agents: PENDING_APPROVAL becomes a wait for the final result. */
  wrap(gateway: ToolGateway): ToolGateway {
    return {
      dispatch: async (call) => {
        const r = await gateway.dispatch(call);
        if (r.status !== "PENDING_APPROVAL") return r;
        return this.wait(r.approvalId, r.toolRequestId);
      },
    };
  }

  private async wait(approvalId: string, toolRequestId: string): Promise<ToolCallResult> {
    const rec = await this.store.get(approvalId);
    if (!rec || rec.status !== "PENDING") return denied(toolRequestId, "approval.closed", "approval is no longer pending");
    return new Promise<ToolCallResult>((resolve) => {
      const delay = Math.max(0, Date.parse(rec.expiresAt) - this.now().getTime());
      const timer = setTimeout(() => void this.closeAndSettle(approvalId, "EXPIRED", "approval window elapsed"), delay);
      this.waiters.set(approvalId, { resolve, timer });
    });
  }

  private settle(approvalId: string, result: ToolCallResult) {
    const w = this.waiters.get(approvalId);
    if (!w) return;
    clearTimeout(w.timer);
    this.waiters.delete(approvalId);
    w.resolve(result);
  }

  private async closeAndSettle(approvalId: string, status: "EXPIRED" | "CANCELLED", reason: string) {
    const rec = await this.store.get(approvalId);
    if (!rec) return;
    await this.store.close(approvalId, status, reason);
    const after = await this.store.get(approvalId);
    if (after && after.status !== "PENDING" && after.status !== "CONSUMED")
      this.settle(approvalId, denied(rec.request.toolRequestId, `approval.${after.status.toLowerCase()}`, after.status === status ? reason : `approval ${after.status.toLowerCase()}`));
  }

  /** Execution left RUNNING, or one of its inputs became unusable → cancel its pending approvals. */
  private async onEvent(e: RunEvent) {
    let match: ((r: PendingToolApproval) => boolean) | null = null;
    let reason = "";
    if (e.type === "task.state_changed" && e.payload.from === "RUNNING") {
      const exec = e.payload.executionId;
      match = (r) => r.call.executionId === exec;
      reason = `execution ${e.payload.to.toLowerCase()}`;
    } else if (
      (e.type === "source.security_state_changed" && e.payload.to !== "CLEAR") ||
      (e.type === "artifact.trust_changed" && e.payload.to !== "CLEAR")
    ) {
      const id = e.type === "source.security_state_changed" ? e.payload.sourceVersionId : e.payload.artifactVersionId;
      match = (r) => r.request.inputVersionIds.includes(id);
      reason = "an input became unusable";
    }
    if (!match) return;
    for (const r of await this.store.pending(e.runId)) if (match(r)) await this.closeAndSettle(r.id, "CANCELLED", reason);
  }

  /** Human resolution from the operator console. */
  async resolve(input: { approvalId: string; toolRequestId: string; actionDigest: string; decision: "APPROVE" | "REJECT"; actorId: string }) {
    const rec = await this.store.get(input.approvalId);
    if (!rec) throw notFound("tool approval");
    if (rec.request.toolRequestId !== input.toolRequestId) throw new HttpError("VALIDATION", "approval is not for this tool request");
    if (rec.status !== "PENDING") throw new HttpError("CONFLICT", `approval is ${rec.status}`);
    if (Date.parse(rec.expiresAt) <= this.now().getTime()) {
      await this.closeAndSettle(rec.id, "EXPIRED", "approval window elapsed");
      throw new HttpError("EXPIRED", "approval expired");
    }
    const auth = { approvalId: input.approvalId, actionDigest: input.actionDigest, actorId: input.actorId };
    if (input.decision === "REJECT") {
      if (!(await this.service.reject(auth))) throw new HttpError("CONFLICT", "approval could not be rejected (digest mismatch or no longer pending)");
      this.settle(rec.id, denied(rec.request.toolRequestId, "approval.rejected", "rejected by an authorized human"));
      return { status: "REJECTED" as const };
    }
    const result = await this.service.approve(auth);
    const after = await this.store.get(rec.id);
    if (after?.status === "CONSUMED") {
      this.settle(rec.id, result);
      return { status: "CONSUMED" as const, outcome: result.status === "EXECUTED" ? ("EXECUTED" as const) : ("ERROR" as const) };
    }
    // Not consumed: authorization re-checks failed (digest, ownership, changed target/inputs/policy).
    throw new HttpError(result.status === "DENIED" && /Human authorization/.test(result.reason) ? "FORBIDDEN" : "CONFLICT", result.status === "DENIED" ? result.reason : "not approved");
  }

  /** Operator-only private view: the exact target and arguments being approved. */
  async privateView(id: string) {
    const rec = await this.store.get(id);
    if (!rec) return null;
    return {
      id: rec.id,
      status: rec.status,
      actionDigest: rec.actionDigest,
      expiresAt: rec.expiresAt,
      ruleId: rec.ruleId,
      workflowId: rec.workflowId,
      workflowVersion: rec.workflowVersion,
      runId: rec.call.runId,
      taskId: rec.call.taskId,
      agentId: rec.call.agentId,
      executionId: rec.call.executionId,
      toolRequestId: rec.request.toolRequestId,
      tool: rec.call.tool,
      operation: rec.request.operation,
      resource: rec.request.resource,
      destination: rec.request.destination ?? null,
      args: rec.call.args,
      inputVersionIds: rec.request.inputVersionIds,
    };
  }

  runOf(id: string) {
    return this.store.runOf(id);
  }
}

