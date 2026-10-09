import { createServer } from 'node:http';
import { appendFile, readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, basename } from 'node:path';

const required = key => { const value = process.env[key]; if (!value?.trim()) throw new Error(`Missing ${key}`); return value; };
const root = await realpath(required('SANDBOX_TARGET_ROOT'));
const auditPath = resolve(required('SANDBOX_TARGET_AUDIT_PATH'));
const audit = resolve(await realpath(dirname(auditPath)), basename(auditPath));
const outside = relative(root, audit);
if (outside !== '..' && !outside.startsWith('../') && !outside.startsWith('..\\') && !isAbsolute(outside)) throw new Error('Target audit must be outside the content mount');
const port = Number(required('SANDBOX_TARGET_PORT'));
const limit = Number(required('SANDBOX_TARGET_MAX_BYTES'));
if (![port, limit].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Invalid target limits');
const server = createServer(async (req, res) => {
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  try {
    const input = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
    const path = await realpath(resolve(root, '.' + input));
    const rel = relative(root, path);
    if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('Path denied');
    if ((await stat(path)).size > limit) throw new Error('Response too large');
    // The worker cannot mount or edit this log; it is written by the target itself.
    await appendFile(audit, JSON.stringify({ at: new Date().toISOString(), method: req.method, resource: rel }) + '\n');
    const content = await readFile(path);
    if (content.length > limit) throw new Error('Response too large');
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(content);
  } catch { res.writeHead(404).end(); }
});
server.listen(port, required('SANDBOX_TARGET_BIND_HOST'), () => { process.send?.({ port }); });
