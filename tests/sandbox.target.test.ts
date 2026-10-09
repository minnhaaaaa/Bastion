import { it, expect } from "vitest";
import { fork } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, relative, isAbsolute } from "node:path";

it("target serves real content and audits access outside its content mount", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "bastion-target-")));
  const contentDir = join(directory, "content"); await mkdir(contentDir);
  const name = crypto.randomUUID(); const content = crypto.randomUUID(); const outsideName = crypto.randomUUID();
  await writeFile(join(contentDir, name), content); await writeFile(join(directory, outsideName), crypto.randomUUID());
  const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port; await new Promise<void>(resolve => socket.close(() => resolve()));
  const audit = join(directory, "audit.jsonl");
  const target = fork(resolve("sandbox/target.mjs"), [], { silent: true, env: { ...process.env, SANDBOX_TARGET_ROOT: contentDir, SANDBOX_TARGET_AUDIT_PATH: audit, SANDBOX_TARGET_PORT: String(port), SANDBOX_TARGET_BIND_HOST: "127.0.0.1", SANDBOX_TARGET_MAX_BYTES: "65536" } });
  try {
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Target startup timeout")), 5000); target.once("message", () => { clearTimeout(timer); resolve(); }); target.once("exit", () => { clearTimeout(timer); reject(new Error("Target exited")); }); });
    expect(await (await fetch(`http://127.0.0.1:${port}/${name}`)).text()).toBe(content);
    expect((await fetch(`http://127.0.0.1:${port}/..%2F${outsideName}`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/${name}`, { method: "POST" })).status).toBe(405);
    const events = (await readFile(audit, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ method: "GET", resource: name });
    expect(relative(contentDir, audit).startsWith("..")).toBe(true);
  } finally {
    if (target.exitCode === null) { const exit = new Promise<void>(resolve => target.once("exit", () => resolve())); target.kill(); await exit; }
    const rel = relative(await realpath(tmpdir()), directory);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe cleanup");
    await rm(directory, { recursive: true, force: true });
  }
});
