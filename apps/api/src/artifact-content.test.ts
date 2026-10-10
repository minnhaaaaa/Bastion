import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@bastion/db';
import { seedRun, setTaskState } from '@bastion/db/testing';
import { newId } from '@bastion/contracts';
import { createTestApp } from './testing';

it('serves full formatted, redacted responses only to the run owner and blocks unusable outputs', async () => {
  const test = await createTestApp();
  try {
    const seed = await seedRun(test.db, test.journal, { work: [] });
    await test.db.update(schema.projects).set({ ownerId: test.userA }).where(eq(schema.projects.id, seed.project.id));
    const executionId = newId('exec');
    await setTaskState(test.journal, seed.runId, seed.taskIds.work!, executionId, 1, 'PENDING', 'RUNNING');
    const content = `# Summary\n\n**Formatted**\n\n- ${'A sentence. '.repeat(40)}\n\napi_key=private_value`;
    const artifact = await test.broker.publish({ runId: seed.runId, name: 'Answer', producerExecutionId: executionId, producerTaskId: seed.taskIds.work!, content, classification: 'INTERNAL', traceId: seed.traceId });
    const url = `/api/runs/${seed.runId}/artifacts/${artifact.id}/content`;
    expect((await test.app.inject({ url })).statusCode).toBe(401);
    expect((await test.app.inject({ url, headers: test.auth(test.tokenB) })).statusCode).toBe(404);
    const response = await test.app.inject({ url, headers: test.auth(test.tokenA) });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().content).toContain('# Summary\n\n**Formatted**');
    expect(response.json().content.length).toBeGreaterThan(280);
    expect(response.json().content).not.toContain('private_value');
    expect((await test.app.inject({ url: `/api/runs/${seed.runId}/artifacts/${newId('artifact')}/content`, headers: test.auth(test.tokenA) })).statusCode).toBe(404);
    await test.broker.setTrust(artifact.id, 'INVALIDATED');
    expect((await test.app.inject({ url, headers: test.auth(test.tokenA) })).statusCode).toBe(409);
  } finally { await test.close(); }
});
