import neo4j, { type Driver } from "neo4j-driver";
import {
  GraphNodeLabel,
  GraphRelType,
  applyEvent,
  newId,
  type GraphProjector,
  type NewRunEvent,
  type RunEvent,
  type RunSnapshot,
} from "@bastion/contracts";

export interface ProjectorJournal {
  read(runId: string, afterSeq?: number): Promise<RunEvent[]>;
  append(runId: string, events: NewRunEvent[]): Promise<unknown>;
  onCommitted(listener: (e: RunEvent) => void | Promise<void>): () => void;
}

type Stmt = { query: string; params: Record<string, unknown> };

/** dependency_edges.fromType/toType → Neo4j label. TaskSpec-level DEPENDS_ON stays in Postgres. */
const LABEL: Record<string, GraphNodeLabel | undefined> = {
  Agent: "Agent",
  TaskExecution: "TaskExecution",
  Source: "Source",
  ArtifactVersion: "ArtifactVersion",
  ToolCall: "ToolCall",
  Resource: "Resource",
  Policy: "Policy",
  SecurityIncident: "SecurityIncident",
};

const assertLabel = (l: string) => GraphNodeLabel.parse(l);
const assertRel = (r: string) => GraphRelType.parse(r);

function changed<T>(prev: Record<string, T> | undefined, next: Record<string, T>): T[] {
  return Object.entries(next)
    .filter(([k, v]) => !prev || JSON.stringify(prev[k]) !== JSON.stringify(v))
    .map(([, v]) => v);
}

/** Cypher statements that bring the graph from `prev` to `next` (idempotent MERGEs). */
export function statementsFor(prev: RunSnapshot | null, next: RunSnapshot, event: RunEvent): Stmt[] {
  const runId = next.run.id;
  const base = { runId, sourceEventId: event.eventId, seq: event.seq };
  const out: Stmt[] = [];
  const node = (label: string, id: string, props: Record<string, unknown>) =>
    out.push({
      query: `MERGE (n:${assertLabel(label)} {id: $id}) SET n += $props`,
      params: { id, props: { ...props, ...base } },
    });

  for (const ex of changed(prev?.executions, next.executions))
    node("TaskExecution", ex.id, { taskId: ex.taskId, attempt: ex.attempt, state: ex.state, securityState: ex.securityState, title: next.tasks[ex.taskId]?.title ?? ex.taskId });
  for (const s of changed(prev?.sources, next.sources))
    node("Source", s.id, { name: s.name, version: s.version, trust: s.trust, trustState: s.securityState, classification: s.classification, contentHash: s.contentHash });
  for (const a of changed(prev?.artifacts, next.artifacts))
    node("ArtifactVersion", a.id, { name: a.name, version: a.version, trustState: a.trustState, classification: a.classification, contentHash: a.contentHash });
  for (const t of changed(prev?.toolRequests, next.toolRequests))
    node("ToolCall", t.id, { tool: t.toolName, operation: t.operation, resource: t.resource, destination: t.destination, decision: t.decision, ruleId: t.policyRuleId, outcome: t.executionOutcome });
  for (const i of changed(prev?.incidents, next.incidents))
    node("SecurityIncident", i.id, { severity: i.severity, state: i.state, reason: i.reason });

  for (const e of next.edges.slice(prev?.edges.length ?? 0)) {
    const from = LABEL[e.fromType];
    const to = LABEL[e.toType];
    if (!from || !to) continue;
    out.push({
      query:
        `MERGE (a:${assertLabel(from)} {id: $from}) ON CREATE SET a.runId = $runId ` +
        `MERGE (b:${assertLabel(to)} {id: $to}) ON CREATE SET b.runId = $runId ` +
        `MERGE (a)-[r:${assertRel(e.relation)} {id: $edgeId}]->(b) SET r.runId = $runId, r.sourceEventId = $sourceEventId, r.seq = $seq`,
      params: { from: e.fromId, to: e.toId, edgeId: e.id, ...base },
    });
  }
  out.push({
    query: "MERGE (c:ProjectionCursor {runId: $runId}) SET c.seq = $seq",
    params: { runId, seq: event.seq },
  });
  return out;
}

/**
 * Neo4j projection of the event journal (ARCHITECTURE §6.1). Never authoritative:
 * Postgres decides containment; this graph serves queries, visual traversal and cross-checks.
 */
export class Neo4jProjector implements GraphProjector {
  private readonly snapshots = new Map<string, RunSnapshot>();
  private readonly cursors = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();
  private unsubscribe?: () => void;

  constructor(
    private readonly driver: Driver,
    private readonly journal: ProjectorJournal,
    private readonly log: (msg: string, extra?: unknown) => void = () => undefined,
  ) {}

  static connect(uri: string, user: string, password: string) {
    return neo4j.driver(uri, neo4j.auth.basic(user, password));
  }

  /** Apply constraints (schema.cypher statements), then follow the journal. */
  async start(schemaStatements: string[]): Promise<void> {
    const session = this.driver.session();
    try {
      for (const q of schemaStatements) await session.run(q);
    } finally {
      await session.close();
    }
    this.unsubscribe = this.journal.onCommitted((e) => {
      this.enqueue(e);
    });
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    await this.queue;
    await this.driver.close();
  }

  /** Processes events strictly in order without blocking the journal's listeners. */
  private enqueue(e: RunEvent) {
    this.queue = this.queue
      .then(() => this.apply(e))
      .then(() => this.maybeAnnounce(e))
      .catch((err) => this.log("graph projection failed (graph will lag; containment unaffected)", err));
  }

  async apply(event: RunEvent): Promise<void> {
    const runId = event.runId;
    const cursor = await this.projectedUpTo(runId);
    if (event.seq <= cursor) return; // idempotent

    let prev = this.snapshots.get(runId) ?? null;
    if (!prev || prev.lastSeq !== event.seq - 1) {
      // Cold start or gap: rebuild state up to the event before this one from the journal.
      prev = null;
      for (const e of await this.journal.read(runId, 0)) {
        if (e.seq >= event.seq) break;
        prev = applyEvent(prev, e);
      }
    }
    const next = applyEvent(prev, event);
    const stmts = statementsFor(prev, next, event);
    const session = this.driver.session();
    try {
      await session.executeWrite(async (tx) => {
        for (const s of stmts) await tx.run(s.query, s.params);
      });
    } finally {
      await session.close();
    }
    this.snapshots.set(runId, next);
    this.cursors.set(runId, event.seq);
  }

  /** Emit graph.projected after a burst, never in response to itself. */
  private async maybeAnnounce(e: RunEvent) {
    if (e.type === "graph.projected") return;
    const latest = this.snapshots.get(e.runId)?.lastSeq ?? 0;
    if (latest !== e.seq) return;
    await this.journal.append(e.runId, [
      { runId: e.runId, traceId: e.traceId ?? newId("trace"), type: "graph.projected", payload: { upToSeq: e.seq } },
    ]);
  }

  async projectedUpTo(runId: string): Promise<number> {
    const cached = this.cursors.get(runId);
    if (cached !== undefined) return cached;
    const session = this.driver.session();
    try {
      const res = await session.run("MATCH (c:ProjectionCursor {runId: $runId}) RETURN c.seq AS seq", { runId });
      const seq = res.records[0]?.get("seq");
      const n = seq == null ? 0 : neo4j.isInt(seq) ? seq.toNumber() : Number(seq);
      this.cursors.set(runId, n);
      return n;
    } finally {
      await session.close();
    }
  }

  /** Forward closure over vetted data-flow relations, scoped to the run. */
  async impactSet(runId: string, sourceVersionId: string): Promise<{ taskIds: string[]; artifactIds: string[] }> {
    const session = this.driver.session({ defaultAccessMode: neo4j.session.READ });
    try {
      const res = await session.run(
        `MATCH (s:Source {id: $sourceId, runId: $runId})
         OPTIONAL MATCH (s)-[:CONSUMED|PRODUCED|DERIVED_FROM*1..]->(x)
         WHERE x.runId = $runId
         RETURN collect(DISTINCT CASE WHEN x:TaskExecution THEN x.taskId END) AS taskIds,
                collect(DISTINCT CASE WHEN x:ArtifactVersion THEN x.id END) AS artifactIds`,
        { sourceId: sourceVersionId, runId },
      );
      const r = res.records[0];
      return { taskIds: (r?.get("taskIds") as string[]) ?? [], artifactIds: (r?.get("artifactIds") as string[]) ?? [] };
    } finally {
      await session.close();
    }
  }
}

/** Split schema.cypher into executable statements (comments stripped). */
export function parseSchema(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}
