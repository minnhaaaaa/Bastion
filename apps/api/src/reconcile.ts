import { inArray } from "drizzle-orm";
import { latestExecution, newId, type NewRunEvent, type Scheduler } from "@bastion/contracts";
import { schema, type Db, type PgEventJournal } from "@bastion/db";
import { PgToolApprovalStore } from "./toolApprovals";

const REASON = "controller restarted";

/**
 * Boot-time reconciliation. In-memory scheduling/recovery state does not survive a restart, so
 * anything that was in flight is closed out truthfully (never "resumed" as if nothing happened),
 * and runs that still have unresolved incidents are re-adopted so humans can contain/recover them.
 */
export async function reconcileOnBoot(d: { db: Db; journal: PgEventJournal; scheduler?: Scheduler }) {
  const report = { failedRuns: [] as string[], failedRecoveries: [] as string[], adopted: [] as string[], expiredToolApprovals: [] as string[] };
  // Nothing can still be waiting on a tool approval after a restart.
  report.expiredToolApprovals = await new PgToolApprovalStore(d.db, d.journal).expireAll(REASON);
  const rows = await d.db
    .select({ id: schema.runs.id })
    .from(schema.runs)
    .where(inArray(schema.runs.status, ["CREATED", "RUNNING", "RECOVERING", "CONTAINED", "COMPLETED", "FAILED", "RECOVERY_FAILED"]));

  for (const { id: runId } of rows) {
    const s = await d.journal.snapshot(runId);
    if (!s) continue;
    const traceId = newId("trace");
    const batch: NewRunEvent[] = [];

    if (["CREATED", "RUNNING", "RECOVERING"].includes(s.run.status)) {
      for (const taskId of Object.keys(s.tasks)) {
        const ex = latestExecution(s, taskId);
        if (ex && (ex.state === "RUNNING" || ex.state === "READY"))
          batch.push({ runId, traceId, taskId, type: "task.state_changed", payload: { taskId, executionId: ex.id, attempt: ex.attempt, from: ex.state, to: "FAILED", reason: REASON } });
      }
      for (const inc of Object.values(s.incidents).filter((i) => i.state === "RECOVERING")) {
        const plan = Object.values(s.plans).filter((p) => p.incidentId === inc.id).at(-1)!;
        batch.push(
          { runId, traceId, type: "verification.completed", payload: { incidentId: inc.id, checks: [{ name: "rerun", passed: false, detail: REASON }] } },
          { runId, traceId, type: "recovery.completed", payload: { incidentId: inc.id, planId: plan.id, outcome: "RECOVERY_FAILED" } },
        );
        report.failedRecoveries.push(inc.id);
      }
      const to = s.run.status === "RECOVERING" ? "RECOVERY_FAILED" : "FAILED";
      batch.push({ runId, traceId, type: "run.status_changed", payload: { from: s.run.status, to, reason: REASON } });
      report.failedRuns.push(runId);
      await d.journal.append(runId, batch);
    }

    const after = (await d.journal.snapshot(runId))!;
    const unresolved = Object.values(after.incidents).some((i) => ["OPEN", "QUARANTINED", "RECOVERY_PLANNED", "RECOVERY_FAILED"].includes(i.state));
    if (unresolved && d.scheduler?.adopt && Object.keys(after.tasks).length > 0) {
      await d.scheduler.adopt(runId, after);
      report.adopted.push(runId);
    }
  }
  return report;
}
