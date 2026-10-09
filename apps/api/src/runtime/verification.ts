import { readFile } from "node:fs/promises";
import { WorkflowPolicyEngine } from "@bastion/security";
import { latestExecution, type RunSnapshot, type TargetAudit, type WorkflowDefinition } from "@bastion/contracts";

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

/**
 * Trusted verification derived from recorded state only — no canned results.
 * Used for normal completion and after recovery reruns.
 */
export async function verifyRun(s: RunSnapshot, audit: TargetAudit) {
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
  ].map((c) => (c.detail === undefined ? { name: c.name, passed: c.passed } : c));
}
