/** Opt-in deployment validation. All test content is generated here and persisted via real APIs. */
import { it, expect } from "vitest";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { latestExecution, newId, type Workflow, type RunSnapshot } from "../packages/contracts/src";

it.skipIf(process.env.BASTION_DEPLOYED_RUNTIME_TEST !== "enabled")("running controller plans, executes, verifies and projects a real-model task", async () => {
  process.loadEnvFile(resolve(".env"));
  const required = (key: string) => { const value = process.env[key]; if (!value) throw new Error(`Missing ${key}`); return value; };
  const base = required("API_URL"), token = required("OPERATOR_TOKEN"), reportPath = required("BASTION_DEPLOYED_REPORT");
  const timeout = Number(required("PI_TIMEOUT_MS"));
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("Invalid PI_TIMEOUT_MS");
  const request = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.json() as Promise<T>;
  };
  const health = await request<{ runtimeConnected: boolean; taskPlanningConnected: boolean; graphConnected: boolean }>("/health");
  expect(health).toMatchObject({ runtimeConnected: true, taskPlanningConnected: true, graphConnected: true });
  const marker = crypto.randomUUID();
  const project = await request<{ id: string }>("/api/projects", { commandId: newId("command"), name: `Runtime validation ${marker}` });
  const plan = await request<{ definition: Workflow["definition"] }>(`/api/projects/${project.id}/task-plan`, { commandId: newId("command"), instruction: `Return only a JSON object with a quote field equal to this exact text: ${marker}. This is a text-only task requiring no tools, sources, or external facts.` });
  expect(plan.definition.agents.every(agent => agent.capabilities.length === 0)).toBe(true);
  expect(plan.definition.sources).toEqual([]);
  expect(plan.definition.policyRules).toEqual([]);
  const workflow = await request<Workflow>("/api/workflows", { commandId: newId("command"), projectId: project.id, definition: plan.definition });
  const { runId } = await request<{ runId: string }>("/api/runs", { commandId: newId("command"), workflowId: workflow.id, mode: "PROTECTED" });
  const deadline = Date.now() + timeout * (workflow.definition.tasks.length + 1);
  let snapshot = await request<RunSnapshot>(`/api/runs/${runId}`);
  while (!["COMPLETED", "FAILED"].includes(snapshot.run.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
    snapshot = await request<RunSnapshot>(`/api/runs/${runId}`);
  }
  const completedSeq = snapshot.lastSeq;
  const graphDeadline = Date.now() + timeout;
  while (snapshot.graphProjectedUpTo < completedSeq && Date.now() < graphDeadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
    snapshot = await request<RunSnapshot>(`/api/runs/${runId}`);
  }
  const { FsBlobStore } = await import("../packages/provenance/src");
  const blobs = new FsBlobStore(required("BLOB_DIR"));
  const finalExecution = latestExecution(snapshot, workflow.definition.tasks.at(-1)!.id);
  const finalArtifact = Object.values(snapshot.artifacts).find(artifact => artifact.producerExecutionId === finalExecution?.id);
  let outputCorrect = false;
  if (finalArtifact) {
    const text = new TextDecoder().decode(await blobs.get(finalArtifact.blobRef));
    try { outputCorrect = JSON.parse(text).quote === marker; } catch { /* Invalid output is not a successful result. */ }
  }
  const metrics = await request<Record<string, unknown>>(`/api/runs/${runId}/metrics`);
  const report = { recordedAt: new Date().toISOString(), projectId: project.id, runId, workflowId: workflow.id, health, outputCorrect, status: snapshot.run.status, verification: snapshot.verification, metrics, completedSeq, graphProjectedUpTo: snapshot.graphProjectedUpTo, artifacts: Object.values(snapshot.artifacts).map(artifact => ({ id: artifact.id, contentHash: artifact.contentHash, trustState: artifact.trustState })), expectedMarker: marker };
  await appendFile(reportPath, JSON.stringify(report) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ projectId: project.id, runId, status: snapshot.run.status, graphCaughtUp: snapshot.graphProjectedUpTo >= completedSeq }));
  expect(snapshot.run.status).toBe("COMPLETED");
  expect(outputCorrect).toBe(true);
  expect(snapshot.verification?.length).toBeGreaterThan(0);
  expect(snapshot.verification?.every(check => check.passed)).toBe(true);
  expect(metrics.unsafeActionsExecuted).toBe(0);
  expect(snapshot.graphProjectedUpTo).toBeGreaterThanOrEqual(completedSeq);
  expect(Object.values(snapshot.artifacts).length).toBe(workflow.definition.tasks.length);
}, 900000);

it.skipIf(process.env.BASTION_DEPLOYED_DIAGNOSTIC !== "enabled")("diagnoses the configured planner without executing a task", async () => {
  process.loadEnvFile(resolve(".env"));
  const { createTaskPlanner } = await import("../apps/api/src/task-planning");
  const { piConfigFromEnv } = await import("../packages/runtime-pi/src");
  const cwd = process.env.SANDBOX_WORKSPACE_PATH;
  if (!cwd) throw new Error("SANDBOX_WORKSPACE_PATH required");
  try {
    const plan = await createTaskPlanner(piConfigFromEnv(), cwd)(`Return only a JSON object with a quote field equal to ${crypto.randomUUID()}. This is a text-only task.`);
    console.log({ validPlan: true, tasks: plan.tasks.length });
  } catch (error) {
    const cause = (error as Error).cause;
    console.log({ failureType: cause instanceof Error ? cause.name : typeof cause, detail: cause instanceof Error ? cause.message : "unknown" });
    throw error;
  }
}, 900000);
