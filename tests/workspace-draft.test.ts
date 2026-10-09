import { describe, expect, it } from "vitest";
import { newId, type Workflow } from "../packages/contracts/src";
import { workflowFromForm, withTaskInstruction } from "../apps/web/src/lib/workflow-draft";

function draft() {
  const agent = newId("agent"), task = newId("task"), source = newId("source"), rule = newId("command");
  const rows = { agents: [agent], tasks: [task], sources: [source], rules: [rule] };
  const form = new FormData();
  for (const [key, value] of Object.entries({ name: "Review project", [`${agent}.role`]: "BUILDER", [`${agent}.capabilities`]: "fs.read:/workspace/**\n\n fs.write:/workspace/output/** ", [`${source}.name`]: "Project notes", [`${source}.location`]: "/workspace/notes.md", [`${source}.trust`]: "UNTRUSTED", [`${source}.classification`]: "INTERNAL", [`${task}.title`]: "Review the notes", [`${task}.agent`]: agent, [`${task}.produces`]: "Review", [`${task}.attempts`]: "2", [`${rule}.description`]: "Review writes", [`${rule}.decision`]: "REQUIRE_APPROVAL", [`${rule}.operation`]: "fs.write", [`${rule}.resource`]: "/workspace/output/**" })) form.set(key, value);
  form.append(`${task}.sources`, "Project notes");
  return { rows, form, agent, task, source, rule };
}

describe("visual workflow configuration", () => {
  it("keeps explicitly supplied boundaries, trust, retry policy and source assignments", () => {
    const d = draft(); const result = workflowFromForm(d.form, d.rows);
    expect(result.agents[0]?.capabilities).toEqual(["fs.read:/workspace/**", "fs.write:/workspace/output/**"]);
    expect(result.sources[0]?.trust).toBe("UNTRUSTED");
    expect(result.tasks[0]?.sourceNames).toEqual(["Project notes"]);
    expect(result.tasks[0]?.retryPolicy).toEqual({ maxAttempts: 2, idempotent: false });
    expect(result.policyRules[0]?.decision).toBe("REQUIRE_APPROVAL");
  });
  it("does not supply capabilities or policies when the user grants none", () => {
    const d = draft(); d.form.delete(`${d.agent}.capabilities`); d.rows.rules = [];
    const result = workflowFromForm(d.form, d.rows);
    expect(result.agents[0]?.capabilities).toEqual([]); expect(result.policyRules).toEqual([]);
  });
  it("rejects unconfigured retries and references to removed agents", () => {
    const d = draft(); d.form.delete(`${d.task}.attempts`);
    expect(() => workflowFromForm(d.form, d.rows)).toThrow();
    d.form.set(`${d.task}.attempts`, "1"); d.rows.agents = [];
    expect(() => workflowFromForm(d.form, d.rows)).toThrow();
  });
  it("rejects cyclic dependencies instead of saving an unexecutable workflow", () => {
    const d = draft(); const second = newId("task"); d.rows.tasks.push(second);
    for (const field of ["title", "agent", "produces", "attempts"]) d.form.set(`${second}.${field}`, String(d.form.get(`${d.task}.${field}`)));
    d.form.append(`${d.task}.deps`, second); d.form.append(`${second}.deps`, d.task);
    expect(() => workflowFromForm(d.form, d.rows)).toThrow(/cycle/);
  });
});

describe("task composition", () => {
  it("updates only the selected instruction, retaining every security boundary and original definition", () => {
    const d = draft(); const definition = workflowFromForm(d.form, d.rows);
    const workflow: Workflow = { id: newId("workflow"), projectId: newId("project"), createdAt: new Date().toISOString(), version: 1, definition };
    const updated = withTaskInstruction(workflow, d.task, "  Write a security review  ");
    expect(updated.tasks[0]?.title).toBe("Write a security review");
    expect(updated.agents).toEqual(definition.agents); expect(updated.policyRules).toEqual(definition.policyRules);
    expect(updated.sources).toEqual(definition.sources);
    expect(updated.tasks[0]).toEqual({ ...definition.tasks[0], title: "Write a security review" });
    expect(definition.tasks[0]?.title).toBe("Review the notes");
    expect(() => withTaskInstruction(workflow, newId("task"), "Do work")).toThrow("Choose a task");
    expect(() => withTaskInstruction(workflow, d.task, "   ")).toThrow();
  });
});
