import type { RunEvent } from "./events";
import type { DependencyEdge, TaskExecution } from "./entities";
import type { GraphRelType } from "./enums";
import type { GraphView, GraphViewEdge, GraphViewNode, RunSnapshot } from "./snapshot";

/**
 * Pure event reducer shared by API (snapshots, replay) and web (live rendering).
 * Replaying the journal from seq 1 and applying live events one-by-one MUST give
 * identical results (acceptance test #7) — so keep this file free of clocks,
 * randomness and I/O.
 *
 * Edge direction convention: all provenance edges point DOWNSTREAM (data-flow),
 * so the impact set of a source is a forward traversal.
 *   (Agent)          -[:EXECUTED]->     (TaskExecution)
 *   (Source|Artifact)-[:CONSUMED]->     (TaskExecution)      "was consumed by"
 *   (TaskExecution)  -[:PRODUCED]->     (ArtifactVersion)
 *   (Source|Artifact)-[:DERIVED_FROM]-> (ArtifactVersion)    "is an origin of"
 *   (TaskExecution)  -[:REQUESTED]->    (ToolCall)
 *   (ToolCall)       -[:TARGETED]->     (Resource)
 *   (ToolCall)       -[:GOVERNED_BY]->  (Policy)
 *   (Source|Artifact|ToolCall)-[:FLAGGED_IN]->(SecurityIncident)
 *   (TaskSpec dep)   -[:DEPENDS_ON]->   (TaskSpec)            upstream → downstream
 */

export class SeqGapError extends Error {
  constructor(
    readonly expected: number,
    readonly got: number,
  ) {
    super(`event seq gap: expected ${expected}, got ${got}; resubscribe for a fresh snapshot`);
  }
}

export function emptySnapshot(runId: string, projectId: string, scenarioId: string, mode: "PROTECTED" | "BASELINE"): RunSnapshot {
  return {
    run: { id: runId, projectId, scenarioId, mode, status: "CREATED", startedAt: null, finishedAt: null },
    tasks: {},
    executions: {},
    latestExecutionByTask: {},
    sources: {},
    artifacts: {},
    edges: [],
    toolRequests: {},
    incidents: {},
    plans: {},
    approvals: {},
    alerts: [],
    verification: null,
    graphProjectedUpTo: 0,
    lastSeq: 0,
  };
}

/**
 * Apply one event. Returns a new snapshot (input is not mutated).
 * - Already-applied events (seq <= lastSeq) are ignored → safe on reconnect overlap.
 * - A gap throws SeqGapError → client should resubscribe without lastSeq.
 */
export function applyEvent(prev: RunSnapshot | null, e: RunEvent): RunSnapshot {
  if (prev === null) {
    if (e.type !== "run.created") throw new Error(`first event must be run.created, got ${e.type}`);
    const s = emptySnapshot(e.runId, e.payload.projectId, e.payload.scenarioId, e.payload.mode);
    s.lastSeq = e.seq;
    return s;
  }
  if (e.seq <= prev.lastSeq) return prev;
  if (e.seq !== prev.lastSeq + 1) throw new SeqGapError(prev.lastSeq + 1, e.seq);

  const s: RunSnapshot = structuredClone(prev);
  s.lastSeq = e.seq;
  let edgeN = 0;
  const edge = (fromType: string, fromId: string, toType: string, toId: string, relation: GraphRelType) => {
    const d: DependencyEdge = {
      id: `edge_${e.seq}_${edgeN++}`,
      runId: e.runId,
      fromType,
      fromId,
      toType,
      toId,
      relation,
      sourceEventId: e.eventId,
    };
    s.edges.push(d);
  };
  const kindOf = (id: string) => (id.startsWith("src_") ? "Source" : "ArtifactVersion");

  switch (e.type) {
    case "run.created":
      break;

    case "run.status_changed": {
      s.run.status = e.payload.to;
      if (e.payload.to === "RUNNING" && !s.run.startedAt) s.run.startedAt = e.timestamp;
      if (["COMPLETED", "FAILED", "RECOVERED", "RECOVERY_FAILED"].includes(e.payload.to)) s.run.finishedAt = e.timestamp;
      break;
    }

    case "run.planned": {
      for (const t of e.payload.tasks) {
        s.tasks[t.taskId] = {
          id: t.taskId,
          runId: e.runId,
          role: t.role,
          agentId: t.agentId,
          title: t.title,
          declaredDeps: t.declaredDeps,
          sourceIds: t.sourceIds,
          retryPolicy: { maxAttempts: 2, idempotent: true },
        };
        for (const dep of t.declaredDeps) edge("TaskSpec", dep, "TaskSpec", t.taskId, "DEPENDS_ON");
      }
      break;
    }

    case "task.state_changed": {
      const p = e.payload;
      let ex: TaskExecution | undefined = s.executions[p.executionId];
      if (!ex) {
        ex = {
          id: p.executionId,
          taskId: p.taskId,
          attempt: p.attempt,
          state: p.to,
          securityState: "CLEAR",
          sessionId: null,
          startedAt: null,
          finishedAt: null,
        };
        s.executions[p.executionId] = ex;
        s.latestExecutionByTask[p.taskId] = p.executionId;
      }
      ex.state = p.to;
      if (p.to === "RUNNING" && !ex.startedAt) ex.startedAt = e.timestamp;
      if (p.to === "SUCCEEDED" || p.to === "FAILED") ex.finishedAt = e.timestamp;
      break;
    }

    case "task.security_state_changed": {
      const ex = s.executions[e.payload.executionId];
      if (ex) ex.securityState = e.payload.to;
      break;
    }

    case "agent.session_started": {
      const ex = s.executions[e.payload.executionId];
      if (ex) ex.sessionId = e.payload.sessionId;
      edge("Agent", e.payload.agentId, "TaskExecution", e.payload.executionId, "EXECUTED");
      break;
    }

    case "agent.session_ended":
      break;

    case "source.ingested":
    case "source.modified": {
      const p = e.payload;
      s.sources[p.sourceVersionId] = {
        id: p.sourceVersionId,
        runId: e.runId,
        name: p.name,
        version: p.version,
        contentHash: p.contentHash,
        trust: p.trust,
        securityState: "CLEAR",
        classification: p.classification,
        blobRef: p.blobRef,
        preview: p.preview,
      };
      break;
    }

    case "source.security_state_changed": {
      const src = s.sources[e.payload.sourceVersionId];
      if (src) src.securityState = e.payload.to;
      break;
    }

    case "artifact.published": {
      const p = e.payload;
      s.artifacts[p.artifactVersionId] = {
        id: p.artifactVersionId,
        runId: e.runId,
        name: p.name,
        version: p.version,
        contentHash: p.contentHash,
        sourceIds: p.sourceIds,
        producerExecutionId: p.producerExecutionId,
        classification: p.classification,
        trustState: p.trustState,
        blobRef: p.blobRef,
        preview: p.preview,
      };
      edge("TaskExecution", p.producerExecutionId, "ArtifactVersion", p.artifactVersionId, "PRODUCED");
      for (const up of p.derivedFrom) edge("ArtifactVersion", up, "ArtifactVersion", p.artifactVersionId, "DERIVED_FROM");
      for (const src of p.sourceIds) edge("Source", src, "ArtifactVersion", p.artifactVersionId, "DERIVED_FROM");
      break;
    }

    case "artifact.consumed": {
      const p = e.payload;
      edge(kindOf(p.inputVersionId), p.inputVersionId, "TaskExecution", p.consumerExecutionId, "CONSUMED");
      break;
    }

    case "artifact.trust_changed": {
      const a = s.artifacts[e.payload.artifactVersionId];
      if (a) a.trustState = e.payload.to;
      break;
    }

    case "tool.requested": {
      const p = e.payload;
      s.toolRequests[p.toolRequestId] = {
        id: p.toolRequestId,
        runId: e.runId,
        executionId: p.executionId,
        agentId: p.agentId,
        toolName: p.tool,
        operation: p.operation,
        resource: p.resource,
        destination: p.destination,
        argsHash: p.argsHash,
        decision: null,
        policyRuleId: null,
        reason: null,
        executionOutcome: null,
      };
      edge("TaskExecution", p.executionId, "ToolCall", p.toolRequestId, "REQUESTED");
      edge("ToolCall", p.toolRequestId, "Resource", p.destination ?? p.resource, "TARGETED");
      break;
    }

    case "tool.decided": {
      const t = s.toolRequests[e.payload.toolRequestId];
      if (t) {
        t.decision = e.payload.decision;
        t.policyRuleId = e.payload.ruleId;
        t.reason = e.payload.reason;
        if (e.payload.decision === "DENY") t.executionOutcome = "NOT_EXECUTED";
      }
      edge("ToolCall", e.payload.toolRequestId, "Policy", e.payload.ruleId, "GOVERNED_BY");
      break;
    }

    case "tool.executed": {
      const t = s.toolRequests[e.payload.toolRequestId];
      if (t) t.executionOutcome = e.payload.outcome;
      break;
    }

    case "alert.suspicious_content":
      s.alerts.push({ seq: e.seq, targetId: e.payload.targetId, detector: e.payload.detector, reason: e.payload.reason });
      break;

    case "claim.unverified":
      s.alerts.push({ seq: e.seq, targetId: e.payload.artifactVersionId, detector: "claim-verifier", reason: e.payload.reason });
      break;

    case "incident.opened": {
      const p = e.payload;
      s.incidents[p.incidentId] = {
        id: p.incidentId,
        runId: e.runId,
        sourceVersionId: p.sourceVersionId,
        severity: p.severity,
        state: "OPEN",
        reason: p.reason,
        triggerToolRequestId: p.triggerToolRequestId,
      };
      edge("Source", p.sourceVersionId, "SecurityIncident", p.incidentId, "FLAGGED_IN");
      if (p.triggerToolRequestId) edge("ToolCall", p.triggerToolRequestId, "SecurityIncident", p.incidentId, "FLAGGED_IN");
      break;
    }

    case "incident.quarantined": {
      const inc = s.incidents[e.payload.incidentId];
      if (inc) inc.state = "QUARANTINED";
      break;
    }

    case "containment.applied":
      // State changes arrive as their own task/artifact/source events; this is the summary.
      break;

    case "recovery.planned": {
      const p = e.payload;
      s.plans[p.planId] = {
        id: p.planId,
        incidentId: p.incidentId,
        rerunTaskIds: p.rerunTaskIds,
        preservedTaskIds: p.preservedTaskIds,
        replacementSourceVersionId: p.replacementSourceVersionId,
        planDigest: p.planDigest,
      };
      const inc = s.incidents[p.incidentId];
      if (inc) inc.state = "RECOVERY_PLANNED";
      break;
    }

    case "approval.requested": {
      const p = e.payload;
      s.approvals[p.approvalId] = {
        id: p.approvalId,
        incidentId: p.incidentId,
        planId: p.planId,
        actorId: null,
        actionDigest: p.actionDigest,
        expiresAt: p.expiresAt,
        status: "PENDING",
      };
      break;
    }

    case "approval.resolved": {
      const a = s.approvals[e.payload.approvalId];
      if (a) {
        a.status = e.payload.status;
        a.actorId = e.payload.actorId;
      }
      break;
    }

    case "recovery.started": {
      const inc = s.incidents[e.payload.incidentId];
      if (inc) inc.state = "RECOVERING";
      break;
    }

    case "verification.completed":
      s.verification = e.payload.checks;
      break;

    case "recovery.completed": {
      const inc = s.incidents[e.payload.incidentId];
      if (inc) inc.state = e.payload.outcome === "RECOVERED" ? "RESOLVED" : "RECOVERY_FAILED";
      break;
    }

    case "graph.projected":
      s.graphProjectedUpTo = Math.max(s.graphProjectedUpTo, e.payload.upToSeq);
      break;

    case "policy.unavailable":
      s.alerts.push({ seq: e.seq, targetId: e.payload.toolRequestId ?? e.runId, detector: "policy", reason: e.payload.reason });
      break;

    default: {
      const _exhaustive: never = e;
      return _exhaustive;
    }
  }
  return s;
}

/** Fold a full ordered event list into a snapshot. */
export function replay(events: readonly RunEvent[]): RunSnapshot {
  let s: RunSnapshot | null = null;
  for (const e of events) s = applyEvent(s, e);
  if (!s) throw new Error("no events");
  return s;
}

/**
 * Project a snapshot into a React Flow–friendly graph. Shows every execution attempt
 * (so reruns are visible next to the invalidated originals), sources, artifacts,
 * tool calls and incidents. TaskSpec DEPENDS_ON edges are omitted (implied by data flow).
 */
export function toGraphView(s: RunSnapshot): GraphView {
  const nodes: GraphViewNode[] = [];
  const ids = new Set<string>();
  const add = (n: GraphViewNode) => {
    nodes.push(n);
    ids.add(n.id);
  };

  for (const src of Object.values(s.sources)) {
    add({ id: src.id, label: "Source", title: `${src.name} v${src.version}`, securityState: src.securityState });
  }
  for (const ex of Object.values(s.executions)) {
    const task = s.tasks[ex.taskId];
    add({
      id: ex.id,
      label: "TaskExecution",
      title: task?.title ?? ex.taskId,
      taskState: ex.state,
      securityState: ex.securityState,
      attempt: ex.attempt,
    });
  }
  for (const a of Object.values(s.artifacts)) {
    add({ id: a.id, label: "ArtifactVersion", title: `${a.name} v${a.version}`, securityState: a.trustState });
  }
  for (const t of Object.values(s.toolRequests)) {
    add({ id: t.id, label: "ToolCall", title: `${t.toolName} ${t.destination ?? t.resource}`, decision: t.decision ?? undefined });
  }
  for (const inc of Object.values(s.incidents)) {
    add({ id: inc.id, label: "SecurityIncident", title: `${inc.severity}: ${inc.reason}` });
  }

  const edges: GraphViewEdge[] = s.edges
    .filter((d) => ids.has(d.fromId) && ids.has(d.toId))
    .map((d) => ({ id: d.id, source: d.fromId, target: d.toId, relation: d.relation }));

  return { nodes, edges };
}

/** Latest execution for a task, if any. */
export function latestExecution(s: RunSnapshot, taskId: string): TaskExecution | undefined {
  const id = s.latestExecutionByTask[taskId];
  return id ? s.executions[id] : undefined;
}
