import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { PgEventJournal, schema } from "@bastion/db";
import { createTestDb, seedRun } from "@bastion/db/testing";
import { newId } from "@bastion/contracts";
import { toolApprovalDigest, type PendingToolApproval } from "@bastion/security";
import { approvedFiles, GitHubPublishing } from "./github-publishing";
import type { GitHubAuth } from "./github-auth";
import type { RepositoryAccess } from "./repository-access";
import { RunService, type AppDeps } from "./context";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function setup() {
  const t = await createTestDb(); cleanup.push(t.close);
  const journal = new PgEventJournal(t.db), seed = await seedRun(t.db, journal, { work: [] });
  const root = await mkdtemp(join(tmpdir(), "bastion-publish-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const content = crypto.randomUUID(), file = 'README.md', target = '/workspace/' + file;
  await writeFile(join(root, file), content);
  const revision = randomBytes(20).toString('hex'), commit = randomBytes(20).toString('hex');
  const access: RepositoryAccess = { directory: '/workspace', revision, remoteUrl: 'https://github.example.invalid/test/repository', sources: [{ name: file, location: target, trust: 'UNTRUSTED', classification: 'INTERNAL' }], permissions: [{ operation: 'fs.read', decision: 'ALLOW' }, { operation: 'fs.write', decision: 'REQUIRE_APPROVAL' }], policyRules: [], connectedAt: new Date().toISOString() };
  const s = (await journal.snapshot(seed.runId))!; s.run.status = 'COMPLETED'; s.verification = [{ name: 'recorded check', passed: true }];
  const executionId = newId('exec'), toolRequestId = newId('tool'), approvalId = newId('toolApproval');
  const data = { id: approvalId, workflowId: s.run.workflowId, workflowVersion: s.run.workflowVersion, call: { runId: seed.runId, executionId, taskId: seed.taskIds.work!, agentId: seed.agent, traceId: seed.traceId, tool: 'write', args: { path: target, content } }, request: { runId: seed.runId, agentId: seed.agent, executionId, toolRequestId, tool: 'write', operation: 'fs.write', resource: target, inputClassification: 'INTERNAL' as const, inputVersionIds: [] }, ruleId: crypto.randomUUID(), expiresAt: new Date().toISOString() };
  const record: PendingToolApproval = { ...data, status: 'CONSUMED', actionDigest: toolApprovalDigest(data) };
  s.toolRequests[toolRequestId] = { id: toolRequestId, executionId, operation: 'fs.write', decision: 'ALLOW', executionOutcome: 'SUCCESS', resource: createHash('sha256').update(target).digest('hex') } as typeof s.toolRequests[string];
  s.toolApprovals[approvalId] = { id: approvalId, toolRequestId, executionId, status: 'CONSUMED', actorId: seed.project.ownerId, actionDigest: record.actionDigest } as typeof s.toolApprovals[string];
  await t.db.insert(schema.toolApprovals).values({ id: approvalId, runId: seed.runId, executionId, toolRequestId, status: 'CONSUMED', actionDigest: record.actionDigest, expiresAt: data.expiresAt, record, actorId: seed.project.ownerId });
  await t.db.insert(schema.runPullRequests).values({ runId: seed.runId, repository: access, requested: true, status: 'WAITING' });
  vi.spyOn(journal, 'snapshot').mockResolvedValue(s);
  vi.spyOn(journal, 'read').mockResolvedValue([{ type: 'tool.executed', payload: { outcome: 'SUCCESS', toolRequestId } }] as never);
  const token = crypto.randomUUID();
  const auth = { config: { authorizeUrl: 'https://github.example.invalid/login/oauth/authorize', userUrl: 'https://api.example.invalid/user', timeoutMs: 1000 }, accessToken: vi.fn().mockResolvedValue(token) } as unknown as GitHubAuth;
  let advanced = false;
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/repos/test/repository/') return Response.json({ message: 'Not Found' }, { status: 404 });
    const path = url.pathname === '/repos/test/repository' ? '' : url.pathname.replace('/repos/test/repository/', '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path === 'pulls' && !body) return Response.json([]);
    if (path === '') return Response.json({ default_branch: 'test-base' });
    if (path === 'git/ref/heads/test-base') return Response.json({ object: { sha: advanced ? commit : revision } });
    if (path === 'git/commits/' + revision) return Response.json({ tree: { sha: revision } });
    if (path === 'git/trees/' + revision) return Response.json({ tree: [{ path: file, type: 'blob', mode: '100755' }], truncated: false });
    if (path === 'git/trees') return Response.json({ sha: commit });
    if (path === 'git/commits') return Response.json({ sha: commit });
    if (path.startsWith('git/matching-refs/')) return Response.json([]);
    if (path === 'git/refs') return Response.json({ ref: body.ref });
    if (path === 'pulls' && body) return Response.json({ html_url: access.remoteUrl + '/pull/1' });
    throw new Error('Unexpected test API path');
  });
  const service = new GitHubPublishing(t.db, journal, auth, root, '/workspace', request);
  return { ...t, service, request, auth, s, record, access, content, file, toolRequestId, seed, root, token, advanced: () => { advanced = true; } };
}

it('publishes only approved content, preserves file mode, and avoids duplicate PRs on repeat', async () => {
  const t = await setup();
  await writeFile(join(t.root, 'unrelated.txt'), crypto.randomUUID());
  await Promise.all([t.service.publish(t.seed.runId), t.service.publish(t.seed.runId)]);
  expect(await t.service.status(t.seed.runId)).toMatchObject({ status: 'CREATED', url: t.access.remoteUrl + '/pull/1' });
  expect(t.request.mock.calls.some(([url]) => new URL(String(url)).pathname === '/repos/test/repository')).toBe(true);
  expect(t.request.mock.calls.some(([url]) => new URL(String(url)).pathname === '/repos/test/repository/')).toBe(false);
  const bodies = t.request.mock.calls.filter(([, init]) => init?.body).map(([input, init]) => ({ path: new URL(String(input)).pathname, body: JSON.parse(String(init!.body)) }));
  expect(bodies.find(b => b.path.endsWith('/git/trees'))!.body.tree).toEqual([{ path: t.file, type: 'blob', mode: '100755', content: t.content }]);
  expect(bodies.find(b => b.path.endsWith('/git/refs'))!.body.ref).toBe('refs/heads/bastion/' + t.seed.runId);
  expect(bodies.filter(b => b.path.endsWith('/pulls'))).toHaveLength(1);
  const count = t.request.mock.calls.length;
  await t.service.publish(t.seed.runId); expect(t.request).toHaveBeenCalledTimes(count);
  expect(JSON.stringify(await t.service.status(t.seed.runId))).not.toContain(t.token);
});

it('refuses unapproved, failed, changed and out-of-repository writes', async () => {
  const t = await setup();
  expect(approvedFiles(t.s, t.access, [t.record], [t.toolRequestId])).toHaveLength(1);
  const missing = structuredClone(t.s); missing.toolApprovals = {};
  expect(() => approvedFiles(missing, t.access, [t.record], [t.toolRequestId])).toThrow('human approval');
  const failed = structuredClone(t.s); failed.verification![0]!.passed = false;
  expect(() => approvedFiles(failed, t.access, [t.record], [t.toolRequestId])).toThrow('recorded checks');
  const forged = structuredClone(t.record); forged.call.args.content = crypto.randomUUID();
  expect(() => approvedFiles(t.s, t.access, [forged], [t.toolRequestId])).toThrow('no longer matches');
  expect(() => approvedFiles(t.s, { ...t.access, sources: [] }, [t.record], [t.toolRequestId])).toThrow('outside');
  await writeFile(join(t.root, t.file), crypto.randomUUID());
  await t.service.publish(t.seed.runId);
  expect(await t.service.status(t.seed.runId)).toMatchObject({ status: 'FAILED', message: expect.stringContaining('Local files changed') });
  expect(t.request).not.toHaveBeenCalled();
});

it('does not publish when upstream advances or no approved writes occurred', async () => {
  const t = await setup(); t.advanced();
  await t.service.publish(t.seed.runId);
  expect(await t.service.status(t.seed.runId)).toMatchObject({ status: 'FAILED', message: expect.stringContaining('GitHub changed') });
  expect(t.request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  t.s.toolRequests = {};
  await t.service.publish(t.seed.runId);
  expect(await t.service.status(t.seed.runId)).toMatchObject({ status: 'SKIPPED' });
});

it('pins the repository at launch and preserves it when the project connection changes', async () => {
  const t = await setup();
  await t.db.delete(schema.runPullRequests).where(eq(schema.runPullRequests.runId, t.seed.runId));
  await t.db.insert(schema.projectConnections).values({ projectId: t.seed.project.id, repository: t.access });
  const workflow = { ...t.seed.workflow, definition: { ...t.seed.workflow.definition, sources: t.access.sources } };
  await t.service.pin(t.seed.runId, workflow);
  await t.db.update(schema.projectConnections).set({ repository: { ...t.access, remoteUrl: 'https://github.example.invalid/other/repo' } }).where(eq(schema.projectConnections.projectId, t.seed.project.id));
  await t.service.publish(t.seed.runId);
  expect(await t.service.status(t.seed.runId)).toMatchObject({ status: 'CREATED', url: t.access.remoteUrl + '/pull/1' });
});

it('stops publication if containment occurs before a remote write', async () => {
  const t = await setup();
  const previous = t.request.getMockImplementation()!;
  t.request.mockImplementation(async (url, init) => {
    const result = await previous(url, init);
    if (String(url).includes('git/trees/') && init?.method === 'GET') t.s.run.status = 'CONTAINED';
    return result;
  });
  await t.service.publish(t.seed.runId);
  expect(await t.service.status(t.seed.runId)).toMatchObject({ status: 'FAILED' });
  expect(t.request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('neither displays nor publishes an old or unrequested job', async () => {
  const t = await setup();
  await t.db.update(schema.runPullRequests).set({ requested: false }).where(eq(schema.runPullRequests.runId, t.seed.runId));
  await t.service.publish(t.seed.runId);
  await t.service.resume();
  expect(await t.service.status(t.seed.runId)).toBeNull();
  expect(t.request).not.toHaveBeenCalled();
});

it('creates publication jobs only when the caller explicitly opts in', async () => {
  const t = await setup();
  const pin = vi.fn().mockResolvedValue(undefined);
  const service = new RunService({ db: t.db, journal: new PgEventJournal(t.db), launcher: { launch: vi.fn().mockResolvedValue(undefined) }, githubPublishing: { pin } } as unknown as AppDeps, { error: vi.fn() } as never);
  await service.start(t.seed.workflow, 'PROTECTED', []);
  expect(pin).not.toHaveBeenCalled();
  await service.start(t.seed.workflow, 'PROTECTED', [], true);
  expect(pin).toHaveBeenCalledTimes(1);
});
