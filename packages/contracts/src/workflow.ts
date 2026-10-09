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

export const WorkflowDefinition = z
  .object({
    name: z.string().min(1),
    agents: z.array(AgentDefinition).min(1),
    sources: z.array(SourceDefinition),
    tasks: z.array(TaskDefinition).min(1),
    policyRules: z.array(PolicyRule),
    attackPayloads: z.array(AttackPayloadDefinition).default([]),
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
    for (const p of w.attackPayloads)
      if (!sources.has(p.targetSourceName))
        ctx.addIssue({ code: "custom", message: `attack payload ${p.id}: unknown source ${p.targetSourceName}` });
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
