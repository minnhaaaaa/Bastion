import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const required = key => { const value = process.env[key]; if (!value?.trim()) throw new Error(`Missing ${key}`); return value; };
const positive = key => { const value = Number(required(key)); if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${key}`); return value; };
const api = new URL(required('API_URL'));
if (!['http:', 'https:'].includes(api.protocol) || api.username || api.password) throw new Error('Invalid API_URL');
const token = required('OPERATOR_TOKEN');
const workflowId = required('EXPERIMENT_WORKFLOW_ID');
const repetitions = positive('EXPERIMENT_REPETITIONS');
const timeoutMs = positive('EXPERIMENT_TIMEOUT_MS');
const pollMs = positive('EXPERIMENT_POLL_MS');
const pageSize = positive('EXPERIMENT_EVENT_PAGE_SIZE');
const output = required('EXPERIMENT_OUTPUT_PATH');
const request = async (path, body) => {
  const response = await fetch(new URL(path, api), { method: body ? 'POST' : 'GET', redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`API request failed (${response.status})`);
  return response.json();
};
const pinned = await request(`/api/workflows/${encodeURIComponent(workflowId)}`);
const runs = [];
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
for (let repeat = 0; repeat < repetitions; repeat++) {
  for (const mode of ['PROTECTED', 'BASELINE']) {
    // Refuse comparison after an edit: POST /runs pins the workflow's current version.
    const current = await request(`/api/workflows/${encodeURIComponent(workflowId)}`);
    if (current.version !== pinned.version) throw new Error('Workflow changed during comparison');
    const started = performance.now();
    const result = await request('/api/runs', { commandId: 'cmd_' + randomUUID().replaceAll('-', ''), workflowId, mode });
    const runId = result.runId;
    if (typeof runId !== 'string') throw new Error('API returned no runId');
    let snapshot;
    do {
      snapshot = await request(`/api/runs/${encodeURIComponent(runId)}`);
      if (snapshot.run.workflowVersion !== pinned.version) throw new Error('Run pinned an unexpected workflow version');
      if (!['CREATED', 'RUNNING', 'RECOVERING'].includes(snapshot.run.status)) break;
      if (performance.now() - started >= timeoutMs) throw new Error(`Run ${runId} did not settle before the configured timeout`);
      await new Promise(resolve => setTimeout(resolve, pollMs));
    } while (true);
    const events = []; let after = 0;
    while (after < snapshot.lastSeq) {
      const page = await request(`/api/runs/${encodeURIComponent(runId)}/events?after=${after}&limit=${pageSize}`);
      if (!Array.isArray(page) || !page.length || page.some((event, index) => event.seq !== after + index + 1)) throw new Error('Incomplete or non-contiguous event trace');
      events.push(...page); after = page.at(-1).seq;
    }
    const elapsedMs = performance.now() - started;
    const deniedCalls = Object.values(snapshot.toolRequests).filter(req => req.decision === 'DENY').length;
    runs.push({ mode, elapsedMs, deniedCalls, status: snapshot.run.status });
    await appendFile(output, JSON.stringify({ recordedAt: new Date().toISOString(), repeat, runId, mode, workflowId, workflowVersion: pinned.version, elapsedMs, status: snapshot.run.status, toolRequests: snapshot.toolRequests, verification: snapshot.verification, events }) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ runId, mode, status: snapshot.run.status }));
  }
}
const summary = Object.fromEntries([...new Set(runs.map(r => r.mode))].map(mode => {
  const selected = runs.filter(r => r.mode === mode);
  const durations = selected.map(r => r.elapsedMs);
  const meanMs = durations.reduce((sum, n) => sum + n, 0) / durations.length;
  return [mode, { count: selected.length, meanMs, minMs: Math.min(...durations), maxMs: Math.max(...durations), populationStdDevMs: Math.sqrt(durations.reduce((sum, n) => sum + (n - meanMs) ** 2, 0) / durations.length), deniedCalls: selected.map(r => r.deniedCalls), statuses: selected.map(r => r.status) }];
}));
await appendFile(output, JSON.stringify({ kind: 'variance', recordedAt: new Date().toISOString(), workflowId, workflowVersion: pinned.version, summary }) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ summary }));
