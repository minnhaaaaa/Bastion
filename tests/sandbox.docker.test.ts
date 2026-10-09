import { it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, relative, isAbsolute } from "node:path";

const execute = promisify(execFile);
it.skipIf(process.env.SANDBOX_DOCKER_TEST !== "enabled")("Docker: raw network egress is blocked, internal target reachable, target audit isolated", async () => {
  const image = process.env.SANDBOX_NODE_IMAGE;
  if (!image) throw new Error("SANDBOX_NODE_IMAGE is required for the Docker test");
  const dir = await realpath(await mkdtemp(join(tmpdir(), "bastion-docker-")));
  const paths = Object.fromEntries(["workspace", "worker-audit", "content", "target-audit", "outside-audit"].map(n => [n, join(dir, n)]));
  await Promise.all(Object.values(paths).map(path => mkdir(path)));
  const filename = crypto.randomUUID(); const content = crypto.randomUUID(); const port = 18000 + Math.floor(Math.random() * 30000);
  await writeFile(join(paths.content!, filename), content);
  const project = "bastion-test-" + crypto.randomUUID().replaceAll("-", "");
  const compose = join(dir, "compose.json");
  const common = { build: { context: resolve("."), dockerfile: "sandbox/Dockerfile", args: { SANDBOX_NODE_IMAGE: image } }, read_only: true, cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"] };
  const target = (auditDir: string, network: string) => ({ ...common, command: ["node", "/app/target.mjs"], networks: [network], environment: { SANDBOX_TARGET_ROOT: "/content", SANDBOX_TARGET_AUDIT_PATH: "/target-audit/access.jsonl", SANDBOX_TARGET_PORT: String(port), SANDBOX_TARGET_BIND_HOST: "0.0.0.0", SANDBOX_TARGET_MAX_BYTES: "65536" }, volumes: [`${paths.content}:/content:ro`, `${auditDir}:/target-audit`] });
  await writeFile(compose, JSON.stringify({ services: {
    worker: { ...common, networks: ["isolated"], environment: { SANDBOX_ROOT: "/workspace", SANDBOX_AUDIT_PATH: "/audit/access.jsonl", SANDBOX_TOKEN: crypto.randomUUID(), SANDBOX_HTTP_ORIGINS: JSON.stringify([`http://target:${port}`]), SANDBOX_EXEC_COMMANDS: "[]", SANDBOX_TIMEOUT_MS: "2000", SANDBOX_MAX_BYTES: "65536", SANDBOX_PORT: String(port), SANDBOX_BIND_HOST: "0.0.0.0" }, volumes: [`${paths.workspace}:/workspace`, `${paths["worker-audit"]}:/audit`] },
    target: target(paths["target-audit"]!, "isolated"), outside: target(paths["outside-audit"]!, "outside"),
  }, networks: { isolated: { internal: true }, outside: {} } }));
  const docker = async (...args: string[]) => (await execute("docker", ["compose", "-p", project, "-f", compose, ...args], { timeout: 120000, maxBuffer: 2 ** 20 })).stdout.trim();
  try {
    await docker("up", "-d", "--build");
    const ids = await Promise.all(["worker", "target", "outside"].map(name => docker("ps", "-q", name)));
    const inspected = JSON.parse((await execute("docker", ["inspect", ...ids])).stdout) as { NetworkSettings: { Networks: Record<string, { IPAddress: string }> }; Mounts: { Source: string; Destination: string }[] }[];
    const worker = inspected[0]!; const outside = inspected[2]!;
    expect(Object.keys(worker.NetworkSettings.Networks)).toHaveLength(1);
    const network = Object.keys(worker.NetworkSettings.Networks)[0]!;
    expect(JSON.parse((await execute("docker", ["network", "inspect", network])).stdout)[0].Internal).toBe(true);
    expect(worker.Mounts.some(m => m.Destination === "/target-audit" || m.Source === paths["target-audit"])).toBe(false);
    const fetchScript = `fetch(process.argv[1], {signal: AbortSignal.timeout(2000)}).then(async r => {if(!r.ok)process.exit(2);console.log(await r.text())}).catch(()=>process.exit(3))`;
    // Readiness and positive control on each network, before interpreting a failed external request.
    let ready = false;
    for (let i = 0; i < 20; i++) {
      try { expect(await docker("exec", "-T", "worker", "node", "-e", fetchScript, `http://target:${port}/${filename}`)).toBe(content); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    expect(ready).toBe(true);
    const externalIp = Object.values(outside.NetworkSettings.Networks)[0]!.IPAddress;
    const externalUrl = `http://${externalIp}:${port}/${filename}`;
    expect(await docker("exec", "-T", "outside", "node", "-e", fetchScript, externalUrl)).toBe(content);
    await expect(docker("exec", "-T", "worker", "node", "-e", fetchScript, externalUrl)).rejects.toMatchObject({ code: 3 });
    // This is a raw fetch inside the container: worker origin validation was never involved.
    const audit = (await readFile(join(paths["target-audit"]!, "access.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(audit.some(entry => entry.resource === filename)).toBe(true);
    expect(relative(paths.workspace!, paths["target-audit"]!).startsWith("..")).toBe(true);
  } finally {
    await docker("down", "--volumes", "--remove-orphans");
    const rel = relative(await realpath(tmpdir()), await realpath(dir));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe test cleanup");
    await rm(dir, { recursive: true, force: true });
  }
}, 240000);
