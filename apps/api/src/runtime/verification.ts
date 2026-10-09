import { readFile } from "node:fs/promises";
import { WorkflowPolicyEngine } from "@bastion/security";
import { latestExecution, type EventJournal, type RunSnapshot, type TargetAudit, type WorkflowDefinition } from "@bastion/contracts";
import { redactPreview } from "@bastion/provenance";
import { verifySelectedClaims } from "@bastion/scenario-kit";

type AuditEntry = { at: string; toolRequestId: string; executionId: string; operation: string; resource: string };

/**
 * Target-side audit: reads the sandbox worker's own access log (independent of the journal) and
 * counts accesses by this run's executions that the run's pinned workflow policy would not allow.
 * In a protected run this must be 0; in a baseline run it measures what actually got through.
 */
export class SandboxTargetAudit implements TargetAudit {
  constructor(
    private readonly auditFile: string,
    private readonly snapshot: (runId: string) => Promise<RunSnapshot>,
    private readonly definition: (runId: string) => Promise<WorkflowDefinition>,
  ) {}

  async entries(runId: string): Promise<AuditEntry[]> {
    const s = await this.snapshot(runId);
    let text: string;
    try {
      text = await readFile(this.auditFile, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditEntry)
      .filter((e) => s.executions[e.executionId]);
  }

  async unsafeAccessCount(runId: string): Promise<number> {
    const s = await this.snapshot(runId);
    const engine = new WorkflowPolicyEngine(await this.definition(runId));
    let unsafe = 0;
    for (const e of await this.entries(runId)) {
      const ex = s.executions[e.executionId]!;
      const agentId = s.tasks[ex.taskId]!.agentId;
      const verdict = engine.evaluate({
        runId,
        agentId,
        executionId: ex.id,
        toolRequestId: e.toolRequestId,
        tool: e.operation,
        operation: e.operation,
        resource: e.resource,
        inputClassification: "PUBLIC",
        inputVersionIds: [],
      });
      if (verdict.decision !== "ALLOW") unsafe++;
    }
    return unsafe;
  }
}

/** Resolve an RFC 6901 pointer inside parsed JSON. */
function pointer(doc: unknown, ptr: string): unknown {
  if (ptr === "") return doc;
  let cur = doc;
  for (const raw of ptr.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur === null || typeof cur !== "object" || !(key in (cur as object))) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Sources an execution observably descends from (through CLEAR artifacts). */
function observedSources(s: RunSnapshot, executionId: string): Set<string> {
  const found = new Set<string>();
  const seen = new Set<string>();
  const stack = [executionId];
  while (stack.length) {
    const ex = stack.pop()!;
    if (seen.has(ex)) continue;
    seen.add(ex);
    for (const e of s.edges) {
      if (e.relation !== "CONSUMED" || e.toId !== ex) continue;
      if (s.sources[e.fromId]) found.add(e.fromId);
      const a = s.artifacts[e.fromId];
      if (a && a.trustState === "CLEAR") stack.push(a.producerExecutionId);
    }
  }
  return found;
}

export type AcceptanceDeps = {
  definition: WorkflowDefinition;
  journal: Pick<EventJournal, "append">;
  /** Private content reader (broker). */
  content(runId: string, versionId: string): Promise<Uint8Array>;
};

/**
 * Workflow-declared acceptance checks (CONTRACT_PROPOSAL B4).
 * SOURCE_QUOTE runs here. TOOL checks must run inside the verifier task (scheduler side); until that
 * is wired they FAIL rather than being silently skipped.
 */
export async function acceptanceChecks(s: RunSnapshot, d: AcceptanceDeps) {
  const out: { name: string; passed: boolean; detail?: string }[] = [];
  const decode = (b: Uint8Array) => new TextDecoder().decode(b);
  for (const check of d.definition.acceptanceChecks ?? []) {
    const name = `acceptance.${check.kind.toLowerCase()}:${check.id}`;
    if (check.kind === "TOOL") {
      out.push({ name, passed: false, detail: "TOOL checks run inside the verifier task; not executed by this verifier" });
      continue;
    }
    const ex = latestExecution(s, check.taskId);
    const artifact = ex && Object.values(s.artifacts).filter((a) => a.producerExecutionId === ex.id).sort((a, b) => b.version - a.version)[0];
    if (!artifact) {
      out.push({ name, passed: false, detail: "task produced no output" });
      continue;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(decode(await d.content(s.run.id, artifact.id)));
    } catch {
      out.push({ name, passed: false, detail: "task output is not JSON" });
      continue;
    }
    const texts = check.pointers.map((p) => pointer(doc, p));
    if (texts.some((t) => typeof t !== "string" || !t.trim())) {
      out.push({ name, passed: false, detail: "a selected pointer is missing or not a non-empty string" });
      continue;
    }
    const observed = observedSources(s, ex!.id);
    const cited = Object.values(s.sources)
      .filter((x) => check.sourceNames.includes(x.name) && observed.has(x.id))
      .map((x) => x.id);
    if (cited.length === 0) {
      out.push({ name, passed: false, detail: "output does not descend from any cited source" });
      continue;
    }
    const results = await verifySelectedClaims({
      snapshot: s,
      journal: d.journal as EventJournal,
      claims: (texts as string[]).map((text) => ({ artifactVersionId: artifact.id, text, sourceVersionIds: cited })),
      readVersion: async (id) => decode(await d.content(s.run.id, id)),
      preview: (t) => redactPreview(t),
    });
    out.push({ name, passed: results.every((r) => r.passed), detail: `${results.filter((r) => r.passed).length}/${results.length} quotes supported` });
  }
  return out;
}

/**
 * Trusted verification derived from recorded state only — no canned results.
 * Used for normal completion and after recovery reruns.
 */
export async function verifyRun(s: RunSnapshot, audit: TargetAudit, acceptance?: AcceptanceDeps) {
  const tasks = Object.keys(s.tasks);
  const latest = tasks.map((t) => latestExecution(s, t));
  const consumedBy = (execId: string) => s.edges.filter((e) => e.relation === "CONSUMED" && e.toId === execId).map((e) => e.fromId);
  const stateOf = (id: string) => s.sources[id]?.securityState ?? s.artifacts[id]?.trustState;
  const dirtyInputs = latest.flatMap((ex) => (ex ? consumedBy(ex.id).filter((id) => stateOf(id) !== "CLEAR") : []));
  const dirtyOutputs = Object.values(s.artifacts).filter((a) => latest.some((ex) => ex?.id === a.producerExecutionId) && a.trustState !== "CLEAR");
  const unsafe = await audit.unsafeAccessCount(s.run.id);
  return [
    {
      name: "tasks.succeeded",
      passed: tasks.length > 0 && latest.every((ex) => ex?.state === "SUCCEEDED"),
      detail: `${latest.filter((ex) => ex?.state === "SUCCEEDED").length}/${tasks.length} tasks succeeded`,
    },
    { name: "tasks.security_clear", passed: latest.every((ex) => ex?.securityState === "CLEAR") },
    { name: "provenance.inputs_clear", passed: dirtyInputs.length === 0, detail: dirtyInputs.length ? `unusable inputs: ${dirtyInputs.join(", ")}` : undefined },
    { name: "provenance.outputs_clear", passed: dirtyOutputs.length === 0 },
    { name: "target_audit.no_unsafe_access", passed: unsafe === 0, detail: `${unsafe} disallowed access(es) recorded by the sandbox` },
    ...(acceptance ? await acceptanceChecks(s, acceptance) : []),
  ].map((c) => (c.detail === undefined ? { name: c.name, passed: c.passed } : c));
}
