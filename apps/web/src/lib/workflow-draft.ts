import { WorkflowDefinition, type Workflow } from "@bastion/contracts";

export type DraftRows = { agents: string[]; tasks: string[]; sources: string[]; rules: string[] };

/** All workflow values come from the form; enums and validation come from contracts. */
export function workflowFromForm(form: FormData, rows: DraftRows) {
  const value = (key: string) => String(form.get(key) ?? "").trim();
  const list = (key: string) => form.getAll(key).map(String);
  return WorkflowDefinition.parse({
    name: value("name"),
    agents: rows.agents.map(id => ({ id, role: value(`${id}.role`), capabilities: value(`${id}.capabilities`).split("\n").map(s => s.trim()).filter(Boolean) })),
    sources: rows.sources.map(id => ({ name: value(`${id}.name`), location: value(`${id}.location`), trust: value(`${id}.trust`), classification: value(`${id}.classification`) })),
    tasks: rows.tasks.map(id => ({ id, agentId: value(`${id}.agent`), title: value(`${id}.title`), produces: value(`${id}.produces`), declaredDeps: list(`${id}.deps`), sourceNames: list(`${id}.sources`), retryPolicy: { maxAttempts: Number(value(`${id}.attempts`)), idempotent: form.has(`${id}.idempotent`) } })),
    policyRules: rows.rules.map(id => ({ id, description: value(`${id}.description`), decision: value(`${id}.decision`), operation: value(`${id}.operation`), resourcePattern: value(`${id}.resource`) })),
  });
}

/** Preserve the complete workflow and its security settings when composing a new task instruction. */
export function withTaskInstruction(workflow: Workflow, taskId: string, instruction: string) {
  if (!workflow.definition.tasks.some(task => task.id === taskId)) throw new Error("Choose a task in this workflow.");
  return WorkflowDefinition.parse({ ...workflow.definition, tasks: workflow.definition.tasks.map(task => task.id === taskId ? { ...task, title: instruction.trim() } : task) });
}
