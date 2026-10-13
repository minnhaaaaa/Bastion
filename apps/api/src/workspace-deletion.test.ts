import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ProjectRepository, schema } from '@bastion/db';
import { seedRun } from '@bastion/db/testing';
import { newId } from '@bastion/contracts';
import { createTestApp } from './testing';

for (const kind of ['projects', 'runs'] as const) it(`deletes stopped contained ${kind} without rewriting containment evidence`, async () => {
  const t = await createTestApp();
  try {
    const seed = await seedRun(t.db, t.journal, { work: [] });
    await t.db.update(schema.projects).set({ ownerId: t.userA }).where(eq(schema.projects.id, seed.project.id));
    await t.journal.append(seed.runId, [{ runId: seed.runId, traceId: seed.traceId, type: 'run.status_changed', payload: { from: 'RUNNING', to: 'CONTAINED' } }]);
    const before = await t.journal.read(seed.runId);
    const response = await t.app.inject({ method: 'POST', url: `/api/${kind}/${kind === 'projects' ? seed.project.id : seed.runId}/delete`, payload: { commandId: newId('command') }, headers: t.auth(t.tokenA) });
    expect(response.statusCode).toBe(200);
    expect((await t.app.inject({ url: '/api/runs', headers: t.auth(t.tokenA) })).json()).toEqual([]);
    expect(await t.journal.read(seed.runId)).toEqual(before);
    expect((await t.journal.snapshot(seed.runId))?.run.status).toBe('CONTAINED');
  } finally { await t.close(); }
});

it('blocks contained deletion while execution or a tool approval is still active', async () => {
  const t = await createTestApp();
  try {
    const seed = await seedRun(t.db, t.journal, { work: [] });
    await t.db.update(schema.projects).set({ ownerId: t.userA }).where(eq(schema.projects.id, seed.project.id));
    await t.journal.append(seed.runId, [{ runId: seed.runId, traceId: seed.traceId, type: 'run.status_changed', payload: { from: 'RUNNING', to: 'CONTAINED' } }]);
    const executionId = newId('exec');
    await t.db.insert(schema.taskExecutions).values({ id: executionId, runId: seed.runId, taskId: newId('task'), attempt: 1, state: 'RUNNING' });
    const request = () => t.app.inject({ method: 'POST', url: `/api/projects/${seed.project.id}/delete`, payload: { commandId: newId('command') }, headers: t.auth(t.tokenA) });
    expect((await request()).statusCode).toBe(409);
    await t.db.update(schema.taskExecutions).set({ state: 'PAUSED' }).where(eq(schema.taskExecutions.id, executionId));
    await t.db.insert(schema.toolApprovals).values({ id: crypto.randomUUID(), runId: seed.runId, executionId, toolRequestId: crypto.randomUUID(), actionDigest: crypto.randomUUID(), expiresAt: new Date().toISOString(), record: {}, status: 'PENDING' });
    expect((await request()).statusCode).toBe(409);
  } finally { await t.close(); }
});

it('deletes only owned inactive runs, is replayable, and retains audit evidence', async () => {
  const t = await createTestApp();
  try {
    const seed = await seedRun(t.db, t.journal, { work: [] });
    await t.db.update(schema.projects).set({ ownerId: t.userA }).where(eq(schema.projects.id, seed.project.id));
    const url = `/api/runs/${seed.runId}/delete`;
    const payload = { commandId: newId('command') };
    expect((await t.app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url, payload, headers: t.auth(t.tokenB) })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'POST', url, payload, headers: t.auth(t.tokenA) })).statusCode).toBe(409);
    await t.journal.append(seed.runId, [{ runId: seed.runId, traceId: seed.traceId, type: 'run.status_changed', payload: { from: 'RUNNING', to: 'COMPLETED' } }]);
    for (let i = 0; i < 2; i++) expect((await t.app.inject({ method: 'POST', url, payload, headers: t.auth(t.tokenA) })).statusCode).toBe(200);
    expect((await t.app.inject({ url: `/api/runs/${seed.runId}`, headers: t.auth(t.tokenA) })).statusCode).toBe(404);
    expect((await t.app.inject({ url: '/api/runs', headers: t.auth(t.tokenA) })).json()).toEqual([]);
    expect((await t.journal.read(seed.runId)).length).toBeGreaterThan(0);
    expect(await new ProjectRepository(t.db).get(seed.project.id)).not.toBeNull();
  } finally { await t.close(); }
});

it('deletes a project and hides its workflows and runs, blocking stale new launches', async () => {
  const t = await createTestApp();
  try {
    const seed = await seedRun(t.db, t.journal, { work: [] });
    await t.db.update(schema.projects).set({ ownerId: t.userA }).where(eq(schema.projects.id, seed.project.id));
    const url = `/api/projects/${seed.project.id}/delete`;
    const payload = { commandId: newId('command') };
    expect((await t.app.inject({ method: 'POST', url, payload, headers: t.auth(t.tokenB) })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'POST', url, payload, headers: t.auth(t.tokenA) })).statusCode).toBe(409);
    await t.journal.append(seed.runId, [{ runId: seed.runId, traceId: seed.traceId, type: 'run.status_changed', payload: { from: 'RUNNING', to: 'FAILED' } }]);
    expect((await t.app.inject({ method: 'POST', url, payload, headers: t.auth(t.tokenA) })).statusCode).toBe(200);
    expect((await t.app.inject({ url: '/api/projects', headers: t.auth(t.tokenA) })).json()).toEqual([]);
    for (const path of [`/api/runs/${seed.runId}`, `/api/workflows/${seed.workflow.id}`, `/api/workflows?projectId=${seed.project.id}`]) expect((await t.app.inject({ url: path, headers: t.auth(t.tokenA) })).statusCode).toBe(404);
    await expect(t.db.insert(schema.runs).values({ id: newId('run'), projectId: seed.project.id, workflowId: seed.workflow.id, workflowVersion: 1, mode: 'PROTECTED' })).rejects.toThrow();
    expect(await t.journal.snapshot(seed.runId)).not.toBeNull();
  } finally { await t.close(); }
});
