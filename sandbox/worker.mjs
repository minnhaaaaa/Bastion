import { createServer } from 'node:http';
import { appendFile, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, relative, dirname, basename, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { timingSafeEqual } from 'node:crypto';

const required = key => { const value = process.env[key]; if (!value?.trim()) throw new Error(`Missing ${key}`); return value; };
const integer = key => { const value = Number(required(key)); if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${key}`); return value; };
const root = await realpath(required('SANDBOX_ROOT'));
const auditPath = resolve(required('SANDBOX_AUDIT_PATH'));
const audit = resolve(await realpath(dirname(auditPath)), basename(auditPath));
const auditRelative = relative(root, audit);
if (auditRelative !== '..' && !auditRelative.startsWith('../') && !auditRelative.startsWith('..\\') && !isAbsolute(auditRelative)) throw new Error('Worker audit must be outside the agent workspace');
const token = Buffer.from(required('SANDBOX_TOKEN'));
const hosts = JSON.parse(required('SANDBOX_HTTP_ORIGINS'));
const commands = JSON.parse(required('SANDBOX_EXEC_COMMANDS'));
const timeout = integer('SANDBOX_TIMEOUT_MS');
const limit = integer('SANDBOX_MAX_BYTES');
if (!Array.isArray(hosts) || hosts.some(h => typeof h !== 'string' || new URL(h).origin !== h)) throw new Error('Invalid HTTP origins');
if (!Array.isArray(commands) || commands.some(c => !c || typeof c.executable !== 'string' || !isAbsolute(c.executable) || !Array.isArray(c.argv) || c.argv.some(a => typeof a !== 'string'))) throw new Error('Exec allowlist requires exact executable and argv pairs');
const inside = path => { const rel = relative(root, path); if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('Path escapes sandbox'); return path; };
async function filePath(input, write) {
  if (typeof input !== 'string') throw new Error('Missing path');
  const path = inside(resolve(root, input));
  try { return inside(await realpath(path)); }
  catch (error) { if (!write || error.code !== 'ENOENT') throw error; inside(await realpath(dirname(path))); return path; }
}
export async function execute(body) {
  const { operation, resource, args, toolRequestId, executionId } = body;
  if (typeof toolRequestId !== 'string' || typeof executionId !== 'string' || !args || typeof args !== 'object') throw new Error('Invalid request');
  let output;
  // This log records actual target access, independently of policy events.
  const record = () => appendFile(audit, JSON.stringify({ at: new Date().toISOString(), toolRequestId, executionId, operation, resource }) + '\n');
  if (operation === 'fs.read') {
    const path = await filePath(resource, false);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await file.stat()).isFile()) throw new Error('Regular files only');
      await record();
      const content = Buffer.alloc(limit + 1); let bytes = 0;
      while (bytes < content.length) {
        const read = await file.read(content, bytes, content.length - bytes, null);
        if (!read.bytesRead) break;
        bytes += read.bytesRead;
      }
      if (bytes > limit) throw new Error('Output exceeds limit');
      output = content.subarray(0, bytes).toString('utf8');
    } finally { await file.close(); }
  } else if (operation === 'fs.write') {
    const path = await filePath(resource, true);
    if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > limit) throw new Error('Invalid write content');
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      if (!(await file.stat()).isFile()) throw new Error('Regular files only');
      await record(); await file.truncate(0); await file.writeFile(args.content);
      output = { bytes: Buffer.byteLength(args.content) };
    } finally { await file.close(); }
  } else if (operation === 'net.http') {
    const url = new URL(resource);
    if (!hosts.includes(url.origin) || url.username || url.password) throw new Error('Destination denied');
    await record();
    const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new Error('HTTP request failed');
    const reader = response.body.getReader(); const parts = []; let bytes = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > limit) throw new Error('Output exceeds limit'); parts.push(Buffer.from(value)); } }
    finally { await reader.cancel(); }
    output = Buffer.concat(parts).toString('utf8');
  } else if (operation === 'proc.exec') {
    // Exact executable allowlist, no shell, no agent-selected environment variables.
    if (typeof args.executable !== 'string' || !Array.isArray(args.argv) || args.argv.some(a => typeof a !== 'string') || !commands.some(c => c.executable === args.executable && JSON.stringify(c.argv) === JSON.stringify(args.argv)) || resource !== JSON.stringify([args.executable, ...args.argv])) throw new Error('Command denied');
    await record();
    const result = await promisify(execFile)(args.executable, args.argv, { cwd: root, env: {}, timeout, maxBuffer: limit, shell: false });
    output = { stdout: result.stdout, stderr: result.stderr };
  } else throw new Error('Unknown operation');
  return output;
}
const server = createServer(async (req, res) => {
  const authorization = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
  if (authorization.length !== token.length || !timingSafeEqual(authorization, token)) { res.writeHead(401).end(); return; }
  if (req.method !== 'POST' || req.url !== '/dispatch') { res.writeHead(404).end(); return; }
  try {
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) throw new Error('Request exceeds limit'); chunks.push(chunk); }
    const output = await execute(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ output }));
  } catch { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Sandbox operation rejected' })); }
});
server.listen(integer('SANDBOX_PORT'), required('SANDBOX_BIND_HOST'), () => { process.send?.({ port: server.address().port }); });
