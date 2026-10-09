import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestExecution, newId, type NewRunEvent, type RecoveryVerifier, type Scheduler } from "@bastion/contracts";
import { PgEventJournal, PgWorkflowRepository, RunRepository, type Db } from "@bastion/db";
import { createTestDb, seedRun, setTaskState } from "@bastion/db/testing";
import { FsBlobStore, PgArtifactBroker } from "@bastion/provenance";
import { RecoveryError, RecoveryManager } from "./service";

let db: Db, close: () => Promise<void>, dir: string;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  dir = await mkdtemp(join(tmpdir(), "bastion-rec-"));
});
afterEach(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});

/** Test double for Member 2's scheduler: runs tasks through the real broker. */
function fakeScheduler(journal: PgEventJournal, broker: PgArtifactBroker, keyOf: (taskId: string) => string): Scheduler {
  const listeners = new Set<(e: { runId: string; taskId: string; executionId: string; ok: boolean }) => void>();
  return {
    async start() {},
    async hold(runId, taskIds) {
      const s = (await journal.snapshot(runId))!;
      const held: string[] = [];
      for (const t of taskIds) {
        const ex = latestExecution(s, t);
        if (ex?.state === "RUNNING") {
          await setTaskState(journal, runId, t, ex.id, ex.attempt, "RUNNING", "PAUSED");
          held.push(ex.id);
        }
      }
      return { heldExecutionIds: held };
    },
    async rerun(runId, taskIds, replacement) {
      for (const t of taskIds) {
        const s = (await journal.snapshot(runId))!;
        const prev = latestExecution(s, t);
        const ex = newId("exec");
        const attempt = (prev?.attempt ?? 0) + 1;
        await setTaskState(journal, runId, t, ex, attempt, "PENDING", "RUNNING");
        const traceId = newId("trace");
        const deps = s.tasks[t]!.declaredDeps;
        const inputs = deps.length
          ? deps.map((d) => Object.values(s.artifacts).find((a) => a.producerExecutionId === latestExecution(s, d)?.id)!.id)
          : [replacement];
        for (const i of inputs) await broker.consume({ runId, inputVersionId: i, consumerExecutionId: ex, consumerTaskId: t, traceId });
        await broker.publish({ runId, name: keyOf(t), producerExecutionId: ex, producerTaskId: t, content: `${t}#${attempt}`, classification: "PUBLIC", traceId });
        await setTaskState(journal, runId, t, ex, attempt, "RUNNING", "SUCCEEDED");
        for (const l of listeners) l({ runId, taskId: t, executionId: ex, ok: true });
      }
    },
    onTaskSettled(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

async function setup(verifier: RecoveryVerifier) {
  const journal = new PgEventJournal(db);
  const runs = new RunRepository(db);
  const broker = new PgArtifactBroker(journal, runs, new FsBlobStore(dir));
  const seeded = await seedRun(db, journal, { a: [], b: ["a"], c: ["b"], d: [] });
  const { runId, traceId, taskIds, agent } = seeded;
  const keyOf = (id: string) => Object.entries(taskIds).find(([, v]) => v === id)![0];
  let clock = Date.now();
  const scheduler = fakeScheduler(journal, broker, keyOf);
  const mgr = new RecoveryManager({
    journal,
    locate: runs,
    workflows: new PgWorkflowRepository(db),
    scheduler,
    verifier,
    approvalTtlMs: 60_000,
    now: () => new Date(clock),
  });
  mgr.start();

  const bad = await broker.ingestSource({ runId, name: "doc", content: "poisoned", trust: "UNTRUSTED", classification: "PUBLIC", traceId });
  const good = await broker.ingestSource({ runId, name: "doc-vetted", content: "clean", trust: "TRUSTED", classification: "PUBLIC", traceId });
  const indep = await broker.ingestSource({ runId, name: "brief", content: "brief", trust: "TRUSTED", classification: "PUBLIC", traceId });

  const run = async (k: string, input: string) => {
    const ex = newId("exec");
    await setTaskState(journal, runId, taskIds[k]!, ex, 1, "PENDING", "RUNNING");
    await broker.consume({ runId, inputVersionId: input, consumerExecutionId: ex, consumerTaskId: taskIds[k]!, traceId });
    return ex;
  };
  const exD = await run("d", indep.id);
  await broker.publish({ runId, name: "d", producerExecutionId: exD, producerTaskId: taskIds.d!, content: "d", classification: "PUBLIC", traceId });
  await setTaskState(journal, runId, taskIds.d!, exD, 1, "RUNNING", "SUCCEEDED");
  const exA = await run("a", bad.id);
  const artA = await broker.publish({ runId, name: "a", producerExecutionId: exA, producerTaskId: taskIds.a!, content: "a", classification: "PUBLIC", traceId });
  await setTaskState(journal, runId, taskIds.a!, exA, 1, "RUNNING", "SUCCEEDED");
  const exB = await run("b", artA.id);

  // Builder attempts a forbidden call → policy (Member 2) records a DENY.
  const toolId = newId("tool");
  await journal.append(runId, [
    { runId, traceId, type: "tool.requested", payload: { toolRequestId: toolId, executionId: exB, agentId: agent, tool: "http_request", operation: "net.http", resource: "https://blocked.invalid/x", destination: "blocked.invalid", argsHash: "h" } },
    { runId, traceId, type: "tool.decided", payload: { toolRequestId: toolId, decision: "DENY", ruleId: "test.deny", reason: "denied" } },
  ] as NewRunEvent[]);

  return { journal, mgr, runId, taskIds, bad, good, exA, exB, exD, artA, toolId, advance: (ms: number) => (clock += ms) };
}

const passing: RecoveryVerifier = { verify: async () => [{ name: "acceptance", passed: true }] };

describe("RecoveryManager", () => {
  it("deny → auto incident → quarantine → plan → approve → selective rerun → RECOVERED", async () => {
    const t = await setup(passing);
    let s = (await t.journal.snapshot(t.runId))!;
    const incident = Object.values(s.incidents)[0]!;
    expect(incident).toMatchObject({ sourceVersionId: t.bad.id, state: "OPEN", triggerToolRequestId: t.toolId });

    await expect(t.mgr.quarantine(incident.id, t.bad.id, newId("agent"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const user = newId("user");
    await t.mgr.quarantine(incident.id, t.bad.id, user);

    s = (await t.journal.snapshot(t.runId))!;
    expect(s.run.status).toBe("CONTAINED");
    expect(s.sources[t.bad.id]!.securityState).toBe("QUARANTINED");
    expect(s.executions[t.exA]!.securityState).toBe("INVALIDATED");
    expect(s.executions[t.exB]!.securityState).toBe("INVALIDATED");
    expect(s.executions[t.exB]!.state).toBe("PAUSED");
    expect(s.executions[t.exD]!.securityState).toBe("CLEAR");
    expect(s.artifacts[t.artA.id]!.trustState).toBe("INVALIDATED");
    const contained = (await t.journal.read(t.runId)).find((e) => e.type === "containment.applied")!;
    expect(new Set((contained.payload as { affectedTaskIds: string[] }).affectedTaskIds)).toEqual(new Set([t.taskIds.a, t.taskIds.b, t.taskIds.c]));

    await expect(t.mgr.plan(incident.id, t.bad.id)).rejects.toMatchObject({ code: "VALIDATION" });
    const plan = await t.mgr.plan(incident.id, t.good.id);
    expect(plan.rerunTaskIds).toEqual([t.taskIds.a, t.taskIds.b, t.taskIds.c]);
    expect(plan.preservedTaskIds).toEqual([t.taskIds.d]);

    s = (await t.journal.snapshot(t.runId))!;
    const approval = Object.values(s.approvals).find((a) => a.planId === plan.id)!;
    await expect(t.mgr.approveAndRecover({ approvalId: approval.id, planId: plan.id, actionDigest: "sha256:wrong", actorId: user })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(t.mgr.approveAndRecover({ approvalId: approval.id, planId: plan.id, actionDigest: plan.planDigest, actorId: newId("agent") })).rejects.toMatchObject({ code: "FORBIDDEN" });

    await t.mgr.approveAndRecover({ approvalId: approval.id, planId: plan.id, actionDigest: plan.planDigest, actorId: user });
    await t.mgr.idle();
    s = (await t.journal.snapshot(t.runId))!;
    expect(s.run.status).toBe("RECOVERED");
    expect(s.incidents[incident.id]!.state).toBe("RESOLVED");
    expect(s.approvals[approval.id]!.status).toBe("CONSUMED");
    expect(latestExecution(s, t.taskIds.a!)!.attempt).toBe(2);
    expect(latestExecution(s, t.taskIds.b!)!.attempt).toBe(2);
    expect(latestExecution(s, t.taskIds.c!)!.state).toBe("SUCCEEDED");
    // Independent branch untouched (acceptance #5)
    expect(latestExecution(s, t.taskIds.d!)!.id).toBe(t.exD);

    // Single use
    await expect(t.mgr.approveAndRecover({ approvalId: approval.id, planId: plan.id, actionDigest: plan.planDigest, actorId: user })).rejects.toBeInstanceOf(RecoveryError);
  });

  it("expired approvals cannot be used", async () => {
    const t = await setup(passing);
    const incident = Object.values((await t.journal.snapshot(t.runId))!.incidents)[0]!;
    const user = newId("user");
    await t.mgr.quarantine(incident.id, t.bad.id, user);
    const plan = await t.mgr.plan(incident.id, t.good.id);
    const approval = Object.values((await t.journal.snapshot(t.runId))!.approvals)[0]!;
    t.advance(61_000);
    await expect(t.mgr.approveAndRecover({ approvalId: approval.id, planId: plan.id, actionDigest: plan.planDigest, actorId: user })).rejects.toMatchObject({ code: "EXPIRED" });
    expect((await t.journal.snapshot(t.runId))!.approvals[approval.id]!.status).toBe("EXPIRED");
  });

  it("failing verification marks RECOVERY_FAILED (no fabricated success)", async () => {
    const t = await setup({ verify: async () => [{ name: "security", passed: false, detail: "audit hit" }] });
    const incident = Object.values((await t.journal.snapshot(t.runId))!.incidents)[0]!;
    const user = newId("user");
    await t.mgr.quarantine(incident.id, t.bad.id, user);
    const plan = await t.mgr.plan(incident.id, t.good.id);
    const approval = Object.values((await t.journal.snapshot(t.runId))!.approvals)[0]!;
    await t.mgr.approveAndRecover({ approvalId: approval.id, planId: plan.id, actionDigest: plan.planDigest, actorId: user });
    await t.mgr.idle();
    const s = (await t.journal.snapshot(t.runId))!;
    expect(s.run.status).toBe("RECOVERY_FAILED");
    expect(s.incidents[incident.id]!.state).toBe("RECOVERY_FAILED");
  });
});
