import { z } from "zod";
import * as Id from "./ids";
import { AgentRole, AttackCard, Classification, SourceTrust } from "./enums";
import { RetryPolicy } from "./entities";
import { Capability, PolicyRule } from "./policy";

/**
 * Workflow definitions are DATA, not code. They are submitted through the API
 * (POST /api/workflows), validated with these schemas, and stored in Postgres.
 * Agents, tasks, sources, capabilities and policy rules ALL come from here.
 * Nothing about a particular workflow may be hardcoded anywhere in the codebase.
 */

export const AgentDefinition = z.object({
  id: Id.AgentId,
  role: AgentRole,
  capabilities: z.array(Capability),
});
export type AgentDefinition = z.infer<typeof AgentDefinition>;

export const SourceDefinition = z.object({
  /** Logical name, unique within the workflow, e.g. "docs/api-guide.md". */
  name: z.string().min(1),
  trust: SourceTrust,
  classification: Classification,
  /** Where the broker loads the content from at run time (file path or URL inside the sandbox). */
  location: z.string().min(1),
  /**
   * Optional: name of a TRUSTED source in this workflow that can replace this one during recovery.
   * Used to propose a recovery plan automatically after quarantine (e.g. from the Arena).
   */
  fallbackSourceName: z.string().optional(),
});
export type SourceDefinition = z.infer<typeof SourceDefinition>;

export const TaskDefinition = z.object({
  /** Logical task id, unique within the workflow (and therefore within each run). */
  id: Id.TaskId,
  agentId: Id.AgentId,
  title: z.string().min(1),
  declaredDeps: z.array(Id.TaskId),
  /** Logical names of sources this task reads directly. */
  sourceNames: z.array(z.string()),
  /** Logical name of the artifact this task publishes. */
  produces: z.string().min(1),
  retryPolicy: RetryPolicy,
});
export type TaskDefinition = z.infer<typeof TaskDefinition>;

/** Attack payloads the Arena may install. Content is stored server-side and referenced, never sent to clients. */
export const AttackPayloadDefinition = z.object({
  id: z.string().min(1),
  card: AttackCard,
  targetSourceName: z.string(),
  label: z.string(),
  contentLocation: z.string().min(1),
});
export type AttackPayloadDefinition = z.infer<typeof AttackPayloadDefinition>;

/** RFC 6901 JSON pointer ("" = whole document). */
const JsonPointer = z.string().regex(/^(\/([^~/]|~[01])*)*$/, "invalid JSON pointer");

/**
 * Workflow-declared verification (CONTRACT_PROPOSAL B4). Selection is explicit workflow data;
 * model outputs never choose their own checks.
 *  - SOURCE_QUOTE: strings selected from the task's output (parsed as JSON) must appear verbatim in
 *    the cited TRUSTED sources that the output observably descends from.
 *  - TOOL: a registered tool call run through the policy gateway inside the named VERIFIER task.
 */
export const AcceptanceCheck = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("SOURCE_QUOTE"),
    id: z.string().min(1),
    taskId: Id.TaskId,
    pointers: z.array(JsonPointer).min(1),
    sourceNames: z.array(z.string()).min(1),
  }),
  z.object({
    kind: z.literal("TOOL"),
    id: z.string().min(1),
    taskId: Id.TaskId,
    tool: z.string().min(1),
    /** Exact arguments (for proc.exec: executable + argv). Never a shell string. */
    args: z.record(z.unknown()),
  }),
]);
export type AcceptanceCheck = z.infer<typeof AcceptanceCheck>;

export const WorkflowDefinition = z
  .object({
    name: z.string().min(1),
    agents: z.array(AgentDefinition).min(1),
    sources: z.array(SourceDefinition),
    tasks: z.array(TaskDefinition).min(1),
    policyRules: z.array(PolicyRule),
    attackPayloads: z.array(AttackPayloadDefinition).default([]),
    /** Optional; absent = no workflow-declared checks (only the built-in state/audit checks run). */
    acceptanceChecks: z.array(AcceptanceCheck).optional(),
  })
  .superRefine((w, ctx) => {
    const agents = new Set(w.agents.map((a) => a.id));
    const tasks = new Set(w.tasks.map((t) => t.id));
    const sources = new Set(w.sources.map((s) => s.name));
    if (tasks.size !== w.tasks.length) ctx.addIssue({ code: "custom", message: "duplicate task id" });
    if (sources.size !== w.sources.length) ctx.addIssue({ code: "custom", message: "duplicate source name" });
    for (const t of w.tasks) {
      if (!agents.has(t.agentId)) ctx.addIssue({ code: "custom", message: `task ${t.id}: unknown agent ${t.agentId}` });
      for (const d of t.declaredDeps)
        if (!tasks.has(d)) ctx.addIssue({ code: "custom", message: `task ${t.id}: unknown dep ${d}` });
      for (const s of t.sourceNames)
        if (!sources.has(s)) ctx.addIssue({ code: "custom", message: `task ${t.id}: unknown source ${s}` });
    }
    for (const s of w.sources) {
      if (!s.fallbackSourceName) continue;
      const fb = w.sources.find((x) => x.name === s.fallbackSourceName);
      if (!fb) ctx.addIssue({ code: "custom", message: `source ${s.name}: unknown fallback ${s.fallbackSourceName}` });
      else if (fb.trust !== "TRUSTED") ctx.addIssue({ code: "custom", message: `source ${s.name}: fallback must be TRUSTED` });
    }
    for (const p of w.attackPayloads)
      if (!sources.has(p.targetSourceName))
        ctx.addIssue({ code: "custom", message: `attack payload ${p.id}: unknown source ${p.targetSourceName}` });
    const checkIds = new Set<string>();
    for (const c of w.acceptanceChecks ?? []) {
      if (checkIds.has(c.id)) ctx.addIssue({ code: "custom", message: `duplicate acceptance check id ${c.id}` });
      checkIds.add(c.id);
      const task = w.tasks.find((t) => t.id === c.taskId);
      if (!task) {
        ctx.addIssue({ code: "custom", message: `acceptance check ${c.id}: unknown task ${c.taskId}` });
        continue;
      }
      if (c.kind === "SOURCE_QUOTE") {
        for (const n of c.sourceNames) {
          const src = w.sources.find((x) => x.name === n);
          if (!src) ctx.addIssue({ code: "custom", message: `acceptance check ${c.id}: unknown source ${n}` });
          else if (src.trust !== "TRUSTED") ctx.addIssue({ code: "custom", message: `acceptance check ${c.id}: cited source ${n} must be TRUSTED` });
        }
      } else if (w.agents.find((a) => a.id === task.agentId)?.role !== "VERIFIER") {
        ctx.addIssue({ code: "custom", message: `acceptance check ${c.id}: TOOL checks must run in a VERIFIER task` });
      }
    }
    if (findCycle(w.tasks)) ctx.addIssue({ code: "custom", message: "task graph has a cycle" });
  });
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;

export const Workflow = z.object({
  id: Id.WorkflowId,
  projectId: Id.ProjectId,
  version: z.number().int().min(1),
  definition: WorkflowDefinition,
  createdAt: z.string().datetime(),
});
export type Workflow = z.infer<typeof Workflow>;

function findCycle(tasks: { id: string; declaredDeps: string[] }[]): boolean {
  const deps = new Map(tasks.map((t) => [t.id, t.declaredDeps]));
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 2) return false;
    if (state.get(id) === 1) return true;
    state.set(id, 1);
    for (const d of deps.get(id) ?? []) if (visit(d)) return true;
    state.set(id, 2);
    return false;
  };
  return tasks.some((t) => visit(t.id));
}
