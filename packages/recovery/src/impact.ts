import type { RunSnapshot } from "@bastion/contracts";

/** Relations that carry data downstream. Impact = forward closure over these (see reduce.ts). */
const FLOW = new Set(["CONSUMED", "PRODUCED", "DERIVED_FROM"]);

export type Impact = {
  /** Tasks whose observed inputs descend from the source, plus their DEPENDS_ON descendants. */
  taskIds: string[];
  /** Executions that (transitively) consumed the source. */
  executionIds: string[];
  /** Artifact versions derived from the source. */
  artifactIds: string[];
};

/**
 * Authoritative, synchronous impact closure computed from the Postgres-backed snapshot.
 * Conservative: an observed CONSUMED edge counts as dependence even if the model ignored the input.
 */
export function computeImpact(s: RunSnapshot, rootVersionId: string): Impact {
  const out = new Map<string, string[]>();
  for (const e of s.edges) {
    if (!FLOW.has(e.relation)) continue;
    (out.get(e.fromId) ?? out.set(e.fromId, []).get(e.fromId)!).push(e.toId);
  }
  const seen = new Set<string>([rootVersionId]);
  const queue = [rootVersionId];
  while (queue.length) {
    for (const n of out.get(queue.shift()!) ?? []) if (!seen.has(n)) (seen.add(n), queue.push(n));
  }
  const executionIds = [...seen].filter((id) => s.executions[id]);
  const artifactIds = [...seen].filter((id) => s.artifacts[id]);

  const tasks = new Set(executionIds.map((id) => s.executions[id]!.taskId));
  // Tasks that declared the source directly but have not run yet are affected too.
  for (const t of Object.values(s.tasks)) if (t.sourceIds.includes(rootVersionId)) tasks.add(t.id);
  // Downstream tasks (including not-yet-started ones) via declared dependencies.
  const children = new Map<string, string[]>();
  for (const t of Object.values(s.tasks)) for (const d of t.declaredDeps) (children.get(d) ?? children.set(d, []).get(d)!).push(t.id);
  const tq = [...tasks];
  while (tq.length) for (const c of children.get(tq.shift()!) ?? []) if (!tasks.has(c)) (tasks.add(c), tq.push(c));

  return { taskIds: [...tasks], executionIds, artifactIds };
}

/** Untrusted, still-clear sources an execution (transitively) consumed — candidates for an incident. */
export function upstreamUntrustedSources(s: RunSnapshot, executionId: string): string[] {
  const into = new Map<string, string[]>();
  for (const e of s.edges) {
    if (!FLOW.has(e.relation)) continue;
    (into.get(e.toId) ?? into.set(e.toId, []).get(e.toId)!).push(e.fromId);
  }
  const seen = new Set<string>([executionId]);
  const queue = [executionId];
  while (queue.length) for (const n of into.get(queue.shift()!) ?? []) if (!seen.has(n)) (seen.add(n), queue.push(n));
  return [...seen].filter((id) => {
    const src = s.sources[id];
    return src && src.trust === "UNTRUSTED" && src.securityState === "CLEAR";
  });
}

/** Topological order of `subset` using declared deps (Kahn); stable by input order. */
export function topoOrder(s: RunSnapshot, subset: string[]): string[] {
  const want = new Set(subset);
  const order: string[] = [];
  const done = new Set<string>();
  const visit = (id: string, stack: Set<string>) => {
    if (done.has(id)) return;
    if (stack.has(id)) throw new Error(`dependency cycle at ${id}`);
    stack.add(id);
    for (const d of s.tasks[id]?.declaredDeps ?? []) if (want.has(d)) visit(d, stack);
    stack.delete(id);
    done.add(id);
    order.push(id);
  };
  for (const id of subset) visit(id, new Set());
  return order;
}
