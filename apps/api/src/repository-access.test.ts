import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { newId } from "@bastion/contracts";
import { applyRepositoryAccess, repositoryConnector, RepositorySelection } from "./repository-access";
import { compileTaskPlan, type TaskPlanner } from "./task-planning";
import { createTestApp } from "./testing";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "bastion-repository-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo"); await mkdir(repo);
  const gitExecutable = (await promisify(execFile)(process.platform === "win32" ? "where.exe" : "which", ["git"])).stdout.trim().split(/\r?\n/)[0]!;
  const git = (args: string[]) => promisify(execFile)(gitExecutable, ["-C", repo, ...args]);
  await git(["init"]);
  const name = `${crypto.randomUUID()}.txt`;
  await writeFile(join(repo, name), crypto.randomUUID());
  await writeFile(join(repo, ".env"), crypto.randomUUID());
  if (process.platform !== "win32") await symlink("/etc/passwd", join(repo, "link"));
  await git(["add", name, ...(process.platform === "win32" ? [] : ["link"])]);
  const config = { hostRoot: root, workerRoot: "/workspace", gitExecutable, timeoutMs: 10000, maxBytes: 100000, toolOperations: { read: "fs.read", write: "fs.write" } };
  return { root, repo, name, connect: repositoryConnector(config), config, selection: { directory: "repo", permissions: [{ operation: "fs.read" as const, decision: "ALLOW" as const }, { operation: "fs.write" as const, decision: "REQUIRE_APPROVAL" as const }] } };
}
it("connects only tracked regular files, compiles exact grants, and refuses escapes or unreviewed edits", async () => {
  const t = await setup();
  const access = await t.connect(t.selection);
  expect(access.sources.map(source => source.name)).toEqual([t.name]);
  expect(access.sources[0]).toMatchObject({ trust: "UNTRUSTED", classification: "INTERNAL", location: `/workspace/repo/${t.name}` });
  expect(access.policyRules).toHaveLength(2);
  const definition = applyRepositoryAccess(compileTaskPlan({ name: crypto.randomUUID(), tasks: [{ key: "task", role: "BUILDER", title: crypto.randomUUID(), dependsOn: [], produces: crypto.randomUUID(), retryPolicy: { maxAttempts: 1, idempotent: true } }] }), access);
  expect(definition.agents[0]!.capabilities).toEqual(access.policyRules.map(rule => `${rule.operation}:${rule.resourcePattern}`));
  expect(definition.tasks[0]!.sourceNames).toEqual([t.name]);
  expect(RepositorySelection.safeParse({ ...t.selection, permissions: [{ operation: "fs.write", decision: "ALLOW" }] }).success).toBe(false);
  expect(RepositorySelection.safeParse({ ...t.selection, permissions: [{ operation: "fs.read", decision: "REQUIRE_APPROVAL" }] }).success).toBe(false);
  await expect(t.connect({ ...t.selection, directory: "../" })).rejects.toThrow("sandbox");
  await expect(repositoryConnector({ ...t.config, maxBytes: 1 })(t.selection)).rejects.toThrow();
});
it("persists owner-scoped access, reuses it for planning, and disconnects without changing existing workflows", async () => {
  const t = await setup();
  const planner = vi.fn<TaskPlanner>(async () => compileTaskPlan({ name: crypto.randomUUID(), tasks: [{ key: "task", role: "RESEARCH", title: crypto.randomUUID(), dependsOn: [], produces: crypto.randomUUID(), retryPolicy: { maxAttempts: 1, idempotent: true } }] }));
  const a = await createTestApp({ repositoryConnector: t.connect, taskPlanner: planner }); cleanup.push(a.close);
  const project = (await a.app.inject({ method: "POST", url: "/api/projects", headers: a.auth(a.tokenA), payload: { commandId: newId("command"), name: crypto.randomUUID() } })).json();
  const url = `/api/projects/${project.id}/repository`;
  const command = { commandId: newId("command"), selection: t.selection };
  const connected = await a.app.inject({ method: "POST", url, headers: a.auth(a.tokenA), payload: command });
  expect(connected.statusCode).toBe(200);
  expect((await a.app.inject({ method: "POST", url, headers: a.auth(a.tokenA), payload: command })).json()).toEqual(connected.json());
  expect((await a.app.inject({ method: "GET", url, headers: a.auth(a.tokenB) })).statusCode).toBe(403);
  expect((await a.app.inject({ method: "POST", url, headers: a.auth(a.tokenB), payload: { ...command, commandId: newId("command") } })).statusCode).toBe(403);
  expect((await a.app.inject({ method: "GET", url, headers: a.auth(a.tokenA) })).json()).toEqual(connected.json());
  const plan = await a.app.inject({ method: "POST", url: `/api/projects/${project.id}/task-plan`, headers: a.auth(a.tokenA), payload: { commandId: newId("command"), instruction: crypto.randomUUID() } });
  expect(plan.statusCode).toBe(200);
  expect(planner.mock.calls[0]?.[2]).toEqual(connected.json().repository);
  expect((await a.app.inject({ method: "POST", url, headers: a.auth(a.tokenA), payload: { commandId: newId("command"), selection: null } })).json()).toEqual({ repository: null });
});
