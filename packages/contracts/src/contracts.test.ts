import { describe, expect, it } from "vitest";
import {
  ArenaActionCmd,
  RunEvent,
  RunId,
  RunSnapshot,
  SeqGapError,
  WorkflowDefinition,
  applyEvent,
  latestExecution,
  newId,
  replay,
  toGraphView,
  type NewRunEvent,
} from "./index";

/**
 * Test-only event builder. Nothing here is shipped: every ID is generated, and the
 * workflow shape is built in code to exercise the reducer — not a demo scenario.
 */
function journal(runId: string) {
  const events: RunEvent[] = [];
  const traceId = newId("trace");
  return {
    events,
    emit(e: Omit<NewRunEvent, "runId" | "traceId">) {
      const seq = events.length + 1;
      events.push(
        RunEvent.parse({ ...e, runId, traceId, eventId: newId("event"), seq, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString() }),
      );
    },
  };
}

/** Builds a chain a → b → c plus an independent task d, then poisons a's source and recovers. */
function buildRun() {
  const runId = newId("run");
  const j = journal(runId);
  const [a, b, c, d] = [newId("task"), newId("task"), newId("task"), newId("task")];
  const agent = newId("agent");
  const [srcBad, srcGood, srcIndep] = [newId("source"), newId("source"), newId("source")];
  const retryPolicy = { maxAttempts: 2, idempotent: true };
  const exec: Record<string, string> = { a1: newId("exec"), b1: newId("exec"), d1: newId("exec"), a2: newId("exec"), b2: newId("exec"), c1: newId("exec") };
  const art = { a1: newId("artifact"), b1: newId("artifact"), d1: newId("artifact"), a2: newId("artifact"), b2: newId("artifact"), c1: newId("artifact") };
  const [tool1, inc, plan, appr] = [newId("tool"), newId("incident"), newId("plan"), newId("approval")];

  j.emit({ type: "run.created", payload: { projectId: newId("project"), workflowId: newId("workflow"), workflowVersion: 1, mode: "PROTECTED" } } as never);
  j.emit({
    type: "run.planned",
    payload: {
      tasks: [
        { taskId: a, agentId: agent, role: "RESEARCH", title: "a", declaredDeps: [], sourceIds: [srcBad], retryPolicy },
        { taskId: b, agentId: agent, role: "BUILDER", title: "b", declaredDeps: [a], sourceIds: [], retryPolicy },
        { taskId: c, agentId: agent, role: "VERIFIER", title: "c", declaredDeps: [b], sourceIds: [], retryPolicy },
        { taskId: d, agentId: agent, role: "BUILDER", title: "d", declaredDeps: [], sourceIds: [srcIndep], retryPolicy },
      ],
    },
  } as never);
  const src = (id: string, trust: "TRUSTED" | "UNTRUSTED") =>
    j.emit({ type: "source.ingested", payload: { sourceVersionId: id, name: id, version: 1, contentHash: "h", trust, classification: "PUBLIC", blobRef: `blob://${id}`, preview: "" } } as never);
  src(srcBad, "UNTRUSTED");
  src(srcGood, "TRUSTED");
  src(srcIndep, "TRUSTED");
  j.emit({ type: "run.status_changed", payload: { from: "CREATED", to: "RUNNING" } } as never);

  const runTask = (taskId: string, ex: string, attempt: number, input: string, out: string, derivedFrom: string[], sourceIds: string[]) => {
    j.emit({ type: "task.state_changed", payload: { taskId, executionId: ex, attempt, from: "PENDING", to: "RUNNING" } } as never);
    j.emit({ type: "artifact.consumed", payload: { inputVersionId: input, consumerExecutionId: ex, consumerTaskId: taskId } } as never);
    j.emit({
      type: "artifact.published",
      payload: { artifactVersionId: out, name: taskId, version: attempt, contentHash: "h", producerExecutionId: ex, producerTaskId: taskId, sourceIds, derivedFrom, classification: "INTERNAL", trustState: "CLEAR", blobRef: `blob://${out}`, preview: "" },
    } as never);
    j.emit({ type: "task.state_changed", payload: { taskId, executionId: ex, attempt, from: "RUNNING", to: "SUCCEEDED" } } as never);
  };
  runTask(d, exec.d1!, 1, srcIndep, art.d1, [], [srcIndep]);
  runTask(a, exec.a1!, 1, srcBad, art.a1, [], [srcBad]);
  j.emit({ type: "task.state_changed", payload: { taskId: b, executionId: exec.b1, attempt: 1, from: "PENDING", to: "RUNNING" } } as never);
  j.emit({ type: "artifact.consumed", payload: { inputVersionId: art.a1, consumerExecutionId: exec.b1, consumerTaskId: b } } as never);
  j.emit({ type: "tool.requested", payload: { toolRequestId: tool1, executionId: exec.b1, agentId: agent, tool: "http", operation: "net.http", resource: "r", destination: "x", argsHash: "h" } } as never);
  j.emit({ type: "tool.decided", payload: { toolRequestId: tool1, decision: "DENY", ruleId: "rule", reason: "deny" } } as never);
  j.emit({ type: "incident.opened", payload: { incidentId: inc, sourceVersionId: srcBad, severity: "HIGH", reason: "r", triggerToolRequestId: tool1 } } as never);
  j.emit({ type: "incident.quarantined", payload: { incidentId: inc, sourceVersionId: srcBad, actorId: "user_x" } } as never);
  j.emit({ type: "source.security_state_changed", payload: { sourceVersionId: srcBad, from: "CLEAR", to: "QUARANTINED" } } as never);
  j.emit({ type: "task.state_changed", payload: { taskId: b, executionId: exec.b1, attempt: 1, from: "RUNNING", to: "PAUSED" } } as never);
  j.emit({ type: "task.security_state_changed", payload: { taskId: a, executionId: exec.a1, from: "CLEAR", to: "INVALIDATED" } } as never);
  j.emit({ type: "artifact.trust_changed", payload: { artifactVersionId: art.a1, from: "CLEAR", to: "INVALIDATED" } } as never);
  j.emit({ type: "recovery.planned", payload: { incidentId: inc, planId: plan, rerunTaskIds: [a, b, c], preservedTaskIds: [d], replacementSourceVersionId: srcGood, planDigest: "dg" } } as never);
  j.emit({ type: "approval.requested", payload: { approvalId: appr, incidentId: inc, planId: plan, actionDigest: "dg", expiresAt: new Date(Date.UTC(2026, 0, 2)).toISOString() } } as never);
  j.emit({ type: "approval.resolved", payload: { approvalId: appr, status: "APPROVED", actorId: "user_x" } } as never);
  j.emit({ type: "recovery.started", payload: { incidentId: inc, planId: plan } } as never);
  runTask(a, exec.a2!, 2, srcGood, art.a2, [], [srcGood]);
  runTask(b, exec.b2!, 2, art.a2, art.b2, [art.a2], []);
  runTask(c, exec.c1!, 1, art.b2, art.c1, [art.b2], []);
  j.emit({ type: "verification.completed", payload: { incidentId: inc, checks: [{ name: "check", passed: true }] } } as never);
  j.emit({ type: "recovery.completed", payload: { incidentId: inc, planId: plan, outcome: "RECOVERED" } } as never);
  j.emit({ type: "run.status_changed", payload: { from: "RUNNING", to: "RECOVERED" } } as never);

  return { events: j.events, ids: { a, b, c, d, srcBad, tool1, art } };
}

describe("reducer", () => {
  const { events, ids } = buildRun();

  it("replays to a valid recovered snapshot", () => {
    const s = replay(events);
    expect(() => RunSnapshot.parse(s)).not.toThrow();
    expect(s.run.status).toBe("RECOVERED");
    expect(Object.values(s.incidents)[0]?.state).toBe("RESOLVED");
  });

  it("independent task preserved; affected tasks reran", () => {
    const s = replay(events);
    expect(latestExecution(s, ids.d)?.attempt).toBe(1);
    expect(latestExecution(s, ids.d)?.securityState).toBe("CLEAR");
    expect(latestExecution(s, ids.a)?.attempt).toBe(2);
    expect(latestExecution(s, ids.b)?.attempt).toBe(2);
    expect(s.sources[ids.srcBad]?.securityState).toBe("QUARANTINED");
    expect(s.artifacts[ids.art.a1]?.trustState).toBe("INVALIDATED");
    expect(s.tasks[ids.a]?.retryPolicy).toEqual({ maxAttempts: 2, idempotent: true });
  });

  it("denied tool is recorded as not executed", () => {
    const t = replay(events).toolRequests[ids.tool1];
    expect(t?.decision).toBe("DENY");
    expect(t?.executionOutcome).toBe("NOT_EXECUTED");
  });

  it("incremental application equals full replay, overlap is a no-op (acceptance #7)", () => {
    let live: RunSnapshot | null = null;
    for (const e of events) live = applyEvent(live, e);
    for (const e of events.slice(-5)) live = applyEvent(live, e);
    expect(live).toEqual(replay(events));
  });

  it("detects seq gaps", () => {
    expect(() => applyEvent(replay(events.slice(0, 3)), events[5]!)).toThrow(SeqGapError);
  });

  it("graph view edges only reference existing nodes", () => {
    const g = toGraphView(replay(events));
    const nodeIds = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) expect(nodeIds.has(e.source) && nodeIds.has(e.target)).toBe(true);
  });
});

describe("schemas", () => {
  it("rejects ids with the wrong prefix", () => {
    expect(RunId.safeParse(newId("task")).success).toBe(false);
    expect(RunId.safeParse(newId("run")).success).toBe(true);
  });

  it("arena actions are typed per card", () => {
    const base = { commandId: newId("command"), card: "QUARANTINE", incidentId: newId("incident") };
    expect(ArenaActionCmd.safeParse({ ...base, sourceVersionId: newId("source") }).success).toBe(true);
    expect(ArenaActionCmd.safeParse(base).success).toBe(false);
  });

  it("workflow definitions are validated (unknown refs, cycles)", () => {
    const agent = newId("agent");
    const [t1, t2] = [newId("task"), newId("task")];
    const rp = { maxAttempts: 1, idempotent: true };
    const def = (deps1: string[]) => ({
      name: "w",
      agents: [{ id: agent, role: "RESEARCH", capabilities: [] }],
      sources: [],
      tasks: [
        { id: t1, agentId: agent, title: "t1", declaredDeps: deps1, sourceNames: [], produces: "x", retryPolicy: rp },
        { id: t2, agentId: agent, title: "t2", declaredDeps: [t1], sourceNames: [], produces: "y", retryPolicy: rp },
      ],
      policyRules: [],
    });
    expect(WorkflowDefinition.safeParse(def([])).success).toBe(true);
    expect(WorkflowDefinition.safeParse(def([t2])).success).toBe(false);
    expect(WorkflowDefinition.safeParse(def([newId("task")])).success).toBe(false);
  });
});
