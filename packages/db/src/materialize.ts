/**
 * Keeps the relational tables in lock-step with the event journal. Runs inside the same
 * transaction as the event insert, so tables and events can never disagree.
 * Rows are derived from the shared reducer's snapshot (single source of truth for semantics).
 */
import type { RunSnapshot } from "@bastion/contracts";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Db } from "./client";
import * as t from "./schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function upsert(tx: Tx, table: PgTable, target: unknown, row: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (tx.insert(table) as any).values(row).onConflictDoUpdate({ target, set: row });
}

/** Entries of `next[key]` that are new or changed compared to `prev[key]`. */
function changed<T>(prev: Record<string, T> | undefined, next: Record<string, T>): T[] {
  return Object.entries(next)
    .filter(([k, v]) => !prev || JSON.stringify(prev[k]) !== JSON.stringify(v))
    .map(([, v]) => v);
}

export async function materialize(tx: Tx, prev: RunSnapshot | null, next: RunSnapshot): Promise<void> {
  const runId = next.run.id;
  // FK order: runs → task specs/executions → sources → artifacts → edges/tools → incidents → plans → approvals
  if (!prev || JSON.stringify(prev.run) !== JSON.stringify(next.run)) {
    const r = next.run;
    await upsert(tx, t.runs, t.runs.id, {
      id: r.id,
      projectId: r.projectId,
      workflowId: r.workflowId,
      workflowVersion: r.workflowVersion,
      mode: r.mode,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
    });
  }
  for (const s of changed(prev?.tasks, next.tasks)) {
    await upsert(tx, t.taskSpecs, [t.taskSpecs.runId, t.taskSpecs.id], { ...s });
  }
  for (const e of changed(prev?.executions, next.executions)) {
    await upsert(tx, t.taskExecutions, t.taskExecutions.id, { ...e, runId });
  }
  for (const s of changed(prev?.sources, next.sources)) {
    await upsert(tx, t.sourceVersions, t.sourceVersions.id, { ...s });
  }
  for (const a of changed(prev?.artifacts, next.artifacts)) {
    await upsert(tx, t.artifactVersions, t.artifactVersions.id, { ...a });
  }
  const newEdges = next.edges.slice(prev?.edges.length ?? 0);
  if (newEdges.length) await tx.insert(t.dependencyEdges).values(newEdges).onConflictDoNothing();
  for (const r of changed(prev?.toolRequests, next.toolRequests)) {
    await upsert(tx, t.toolRequests, t.toolRequests.id, { ...r });
  }
  for (const i of changed(prev?.incidents, next.incidents)) {
    await upsert(tx, t.securityIncidents, t.securityIncidents.id, { ...i });
  }
  for (const p of changed(prev?.plans, next.plans)) {
    await upsert(tx, t.recoveryPlans, t.recoveryPlans.id, { ...p });
  }
  for (const a of changed(prev?.approvals, next.approvals)) {
    await upsert(tx, t.approvalRequests, t.approvalRequests.id, { ...a });
  }
}
