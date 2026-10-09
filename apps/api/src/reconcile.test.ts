import { afterEach, describe, expect, it } from "vitest";
import { latestExecution, newId, type NewRunEvent } from "@bastion/contracts";
import { PgEventJournal } from "@bastion/db";
import { createTestDb, seedRun, setTaskState } from "@bastion/db/testing";
import { reconcileOnBoot } from "./reconcile";

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

describe("reconcileOnBoot", () => {
  it("closes in-flight runs, executions and recoveries truthfully", async () => {
    const t = await createTestDb();
    close = t.close;
    const journal = new PgEventJournal(t.db);
    const { runId, taskIds } = await seedRun(t.db, journal, { a: [], b: ["a"] });
    const ex = newId("exec");
    await setTaskState(journal, runId, taskIds.a!, ex, 1, "PENDING", "RUNNING");

    // A second run that was mid-recovery.
    const r2 = await seedRun(t.db, journal, { a: [] });
    const src = newId("source");
    const inc = newId("incident");
    const plan = newId("plan");
    const traceId = newId("trace");
    await journal.append(r2.runId, [
      { runId: r2.runId, traceId, type: "source.ingested", payload: { sourceVersionId: src, name: "n", version: 1, contentHash: "h", trust: "UNTRUSTED", classification: "PUBLIC", blobRef: "b", preview: "" } },
      { runId: r2.runId, traceId, type: "incident.opened", payload: { incidentId: inc, sourceVersionId: src, severity: "HIGH", reason: "r", triggerToolRequestId: null } },
      { runId: r2.runId, traceId, type: "incident.quarantined", payload: { incidentId: inc, sourceVersionId: src, actorId: "user_x" } },
      { runId: r2.runId, traceId, type: "recovery.planned", payload: { incidentId: inc, planId: plan, rerunTaskIds: [], preservedTaskIds: [], replacementSourceVersionId: src, planDigest: "d" } },
      { runId: r2.runId, traceId, type: "recovery.started", payload: { incidentId: inc, planId: plan } },
      { runId: r2.runId, traceId, type: "run.status_changed", payload: { from: "RUNNING", to: "RECOVERING" } },
    ] as NewRunEvent[]);

    const report = await reconcileOnBoot({ db: t.db, journal });
    expect(new Set(report.failedRuns)).toEqual(new Set([runId, r2.runId]));
    expect(report.failedRecoveries).toEqual([inc]);

    const s1 = (await journal.snapshot(runId))!;
    expect(s1.run.status).toBe("FAILED");
    expect(latestExecution(s1, taskIds.a!)!.state).toBe("FAILED");
    const s2 = (await journal.snapshot(r2.runId))!;
    expect(s2.run.status).toBe("RECOVERY_FAILED");
    expect(s2.incidents[inc]!.state).toBe("RECOVERY_FAILED");

    // Idempotent: a second boot changes nothing.
    const again = await reconcileOnBoot({ db: t.db, journal });
    expect(again.failedRuns).toEqual([]);
  });
});
