import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, symlink, rm, chmod, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { newId } from "@bastion/contracts";
import { applyRepositoryAccess, repositoryConnector, RepositorySelection, RepositoryConnectionError } from "./repository-access";
import { compileTaskPlan, type TaskPlanner } from "./task-planning";
import { createTestApp } from "./testing";

const cleanup: (() => Promise<void>)[] = [];
// This generated test executable replaces remote transport with a local test repository.
async function remoteSetup() {
  const t = await setup();
  await promisify(execFile)("/usr/bin/git", ["-C", t.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", crypto.randomUUID()]);
  const executable = join(t.root, "test-git");
  const argsFile = join(t.root, "clone-args.json");
  await writeFile(executable, `#!/usr/bin/python3
import os, sys, json
args=sys.argv[1:]
if "clone" in args:
    open(${JSON.stringify(argsFile)}, "w").write(json.dumps(args))
    args=[("protocol.file.allow=always" if a=="protocol.https.allow=always" else ${JSON.stringify("file://" + t.repo)} if a.startswith("https://") else a) for a in args]
os.execv("/usr/bin/git", ["git"]+args)
`);
  await chmod(executable, 0o700);
  const config = { ...t.config, gitExecutable: executable, remoteOrigins: ["https://github.com"], cloneTimeoutMs: 10000 };
  return { ...t, argsFile, config, connect: repositoryConnector(config), remoteSelection: { ...t.selection, directory: "https://github.com/test/generated-repo" } };
}

it("clones public URLs with restricted transports and refreshes without overwriting edits", async () => {
  const t = await remoteSetup();
  const first = await t.connect(t.remoteSelection);
  expect(first.remoteUrl).toBe(t.remoteSelection.directory);
  expect(first.revision).toMatch(/^[a-f0-9]{40}$/);
  expect(first.sources.map(s => s.name)).toEqual([t.name]);
  expect(first.sources[0]?.trust).toBe("UNTRUSTED");
  expect(first.policyRules.filter(p => p.operation === "fs.write").every(p => p.decision === "REQUIRE_APPROVAL")).toBe(true);
  const args = JSON.parse(await readFile(t.argsFile, "utf8"));
  for (const argument of ["protocol.allow=never", "protocol.https.allow=always", "http.followRedirects=false", "credential.helper=", "--template=", "--no-recurse-submodules", "--depth=1"]) expect(args).toContain(argument);
  const firstFile = join(t.root, first.directory.slice("/workspace/".length), t.name);
  const edit = crypto.randomUUID(); await writeFile(firstFile, edit);
  const second = await t.connect(t.remoteSelection);
  expect(second.directory).not.toBe(first.directory);
  expect(await readFile(firstFile, "utf8")).toBe(edit);
  expect(await readFile(join(t.root, second.directory.slice("/workspace/".length), t.name), "utf8")).not.toBe(edit);
});

it("rejects credential-bearing, unapproved and non-root URLs before cloning", async () => {
  const t = await remoteSetup();
  for (const directory of ["https://attacker.invalid/a/b", "https://token@github.com/a/b", "http://github.com/a/b", "https://github.com/a/b/tree/main", "https://github.com/a/b?token=secret", "git@github.com:a/b"]) {
    await expect(t.connect({ ...t.remoteSelection, directory })).rejects.toBeInstanceOf(RepositoryConnectionError);
  }
  expect((await readdir(t.root)).filter(n => n.startsWith("repository-"))).toEqual([]);
});

it("cleans up failed imports without removing existing repositories", async () => {
  const t = await remoteSetup();
  const before = await readdir(t.root);
  await expect(repositoryConnector({ ...t.config, maxBytes: 1 })(t.remoteSelection)).rejects.toBeInstanceOf(RepositoryConnectionError);
  expect((await readdir(t.root)).filter(n => n !== "clone-args.json")).toEqual(before);
  expect(await readFile(join(t.repo, t.name), "utf8")).toBeTruthy();
});

it("removes a completed clone when tracked sources exceed the budget", async () => {
  const t = await remoteSetup();
  await writeFile(join(t.repo, t.name), crypto.randomUUID().repeat(100));
  await promisify(execFile)("/usr/bin/git", ["-C", t.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-am", crypto.randomUUID()]);
  await expect(repositoryConnector({ ...t.config, maxBytes: 1000 })(t.remoteSelection)).rejects.toThrow("source-size budget");
  expect((await readdir(t.root)).filter(n => n.startsWith("repository-"))).toEqual([]);
  expect(await readFile(join(t.repo, t.name), "utf8")).toHaveLength(3600);
});

it("automatically syncs a remote before planning and stops on sync failure", async () => {
  const t = await remoteSetup();
  const connector = vi.fn(t.connect);
  const planner = vi.fn<TaskPlanner>(async () => compileTaskPlan({ name: crypto.randomUUID(), tasks: [{ key: "task", role: "RESEARCH", title: crypto.randomUUID(), dependsOn: [], produces: crypto.randomUUID(), retryPolicy: { maxAttempts: 1, idempotent: true } }] }));
  const a = await createTestApp({ repositoryConnector: connector, taskPlanner: planner }); cleanup.push(a.close);
  const project = (await a.app.inject({ method: "POST", url: "/api/projects", headers: a.auth(a.tokenA), payload: { commandId: newId("command"), name: crypto.randomUUID() } })).json();
  const url = `/api/projects/${project.id}`;
  const connected = (await a.app.inject({ method: "POST", url: `${url}/repository`, headers: a.auth(a.tokenA), payload: { commandId: newId("command"), selection: t.remoteSelection } })).json().repository;
  const updatedText = crypto.randomUUID();
  await writeFile(join(t.repo, t.name), updatedText);
  await promisify(execFile)("/usr/bin/git", ["-C", t.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-am", crypto.randomUUID()]);
  const payload = { commandId: newId("command"), instruction: crypto.randomUUID() };
  const plan = () => a.app.inject({ method: "POST", url: `${url}/task-plan`, headers: a.auth(a.tokenA), payload });
  expect((await plan()).statusCode).toBe(200);
  const access = planner.mock.calls[0]![2]!;
  expect(access.revision).not.toBe(connected.revision);
  expect(access.permissions).toEqual(connected.permissions);
  expect(await readFile(join(t.root, access.directory.slice("/workspace/".length), t.name), "utf8")).toBe(updatedText);
  expect(await readFile(join(t.root, connected.directory.slice("/workspace/".length), t.name), "utf8")).not.toBe(updatedText);
  expect((await plan()).statusCode).toBe(200);
  expect(connector).toHaveBeenCalledTimes(2);
  connector.mockRejectedValueOnce(new RepositoryConnectionError("Remote unavailable"));
  const failed = await a.app.inject({ method: "POST", url: `${url}/task-plan`, headers: a.auth(a.tokenA), payload: { ...payload, commandId: newId("command") } });
  expect(failed.statusCode).toBe(503);
  expect(planner).toHaveBeenCalledTimes(1);
});
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "bastion-repository-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo"); await mkdir(repo);
  const git = (args: string[]) => promisify(execFile)("/usr/bin/git", ["-C", repo, ...args]);
  await git(["init"]);
  const name = `${crypto.randomUUID()}.txt`;
  await writeFile(join(repo, name), crypto.randomUUID());
  await writeFile(join(repo, ".env"), crypto.randomUUID());
  await symlink("/etc/passwd", join(repo, "link"));
  await git(["add", name, "link"]);
  const config = { hostRoot: root, workerRoot: "/workspace", gitExecutable: "/usr/bin/git", timeoutMs: 10000, maxBytes: 100000, toolOperations: { read: "fs.read", write: "fs.write" } };
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

it("accepts mounted, relative and confined host paths but rejects remote URLs and symlink escapes", async () => {
  const t = await setup();
  for (const directory of ["repo", "/workspace/repo", t.repo]) {
    const access = await t.connect({ ...t.selection, directory });
    expect(access.directory).toBe("/workspace/repo");
    expect(access.sources.map(source => source.location)).toEqual([`/workspace/repo/${t.name}`]);
  }
  for (const directory of ["https://github.com/example/repository", "git@example.test:repository.git"]) {
    await expect(t.connect({ ...t.selection, directory })).rejects.toThrow("not enabled");
  }
  await expect(t.connect({ ...t.selection, directory: "absent" })).rejects.toThrow("does not exist");
  await mkdir(join(t.repo, "nested"));
  await expect(t.connect({ ...t.selection, directory: "repo/nested" })).rejects.toThrow("not a subfolder");
  await mkdir(join(t.root, "plain"));
  await expect(t.connect({ ...t.selection, directory: "plain" })).rejects.toThrow("working repository");
  await symlink(tmpdir(), join(t.root, "escape"));
  await expect(t.connect({ ...t.selection, directory: join(t.root, "escape") })).rejects.toThrow("outside the sandbox");
});

it("returns actionable known errors without exposing raw Git or filesystem failures", async () => {
  const connector = vi.fn().mockRejectedValue(new RepositoryConnectionError("Enter a local repository path, not a GitHub URL."));
  const a = await createTestApp({ repositoryConnector: connector }); cleanup.push(a.close);
  const project = (await a.app.inject({ method: "POST", url: "/api/projects", headers: a.auth(a.tokenA), payload: { commandId: newId("command"), name: crypto.randomUUID() } })).json();
  const request = () => a.app.inject({ method: "POST", url: `/api/projects/${project.id}/repository`, headers: a.auth(a.tokenA), payload: { commandId: newId("command"), selection: { directory: "repo", permissions: [{ operation: "fs.read", decision: "ALLOW" }] } } });
  const known = await request();
  expect(known.statusCode).toBe(400);
  expect(known.json().error.message).toContain("not a GitHub URL");
  const secret = crypto.randomUUID();
  connector.mockRejectedValue(new Error(`Git failed with private environment ${secret}`));
  const unexpected = await request();
  expect(unexpected.statusCode).toBe(400);
  expect(unexpected.body).not.toContain(secret);
  expect(unexpected.json().error.message).toContain("controller configuration");
});
