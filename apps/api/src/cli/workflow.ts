/**
 * Workflow CLI — a tool, not data. Definitions live in files you pass in (outside the repo).
 *
 *   pnpm workflow:validate <file.json>
 *   pnpm workflow:submit   <file.json> --project <proj_id>
 *   pnpm workflow:submit   <file.json> --version-of <wf_id>      (new immutable version)
 *   pnpm workflow:project  <name>                                  (create a project)
 *
 * submit/project need API_URL and OPERATOR_TOKEN in the environment.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WorkflowDefinition, newId } from "@bastion/contracts";

type Out = { log: (s: string) => void; error: (s: string) => void };

export async function validateFile(path: string): Promise<{ ok: true; definition: WorkflowDefinition } | { ok: false; errors: string[] }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    return { ok: false, errors: [`cannot read JSON from ${path}: ${(err as Error).message}`] };
  }
  const parsed = WorkflowDefinition.safeParse(raw);
  if (parsed.success) return { ok: true, definition: parsed.data };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string) {
  const v = env[key];
  if (!v?.trim()) throw new Error(`${key} is required`);
  return v;
}

async function call(env: NodeJS.ProcessEnv, method: string, path: string, body: unknown) {
  const res = await fetch(new URL(path, requiredEnv(env, "API_URL")), {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${requiredEnv(env, "OPERATOR_TOKEN")}` },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(json)}`);
  return json;
}

function flag(args: string[], name: string) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, out: Out): Promise<number> {
  const [cmd, arg, ...rest] = argv;
  // pnpm --filter runs inside apps/api; resolve file paths from where the user ran the command.
  const target = arg && cmd !== "project" ? resolve(env.INIT_CWD ?? process.cwd(), arg) : arg;
  try {
    if (cmd === "validate" && target) {
      const r = await validateFile(target);
      if (!r.ok) return r.errors.forEach((e) => out.error(e)), 1;
      const d = r.definition;
      out.log(`valid: ${d.name} — ${d.agents.length} agents, ${d.tasks.length} tasks, ${d.sources.length} sources, ${d.policyRules.length} rules, ${d.attackPayloads.length} attack payloads`);
      return 0;
    }
    if (cmd === "submit" && target) {
      const r = await validateFile(target);
      if (!r.ok) return r.errors.forEach((e) => out.error(e)), 1;
      const versionOf = flag(rest, "--version-of");
      const projectId = flag(rest, "--project");
      if (!versionOf && !projectId) throw new Error("pass --project <proj_id> or --version-of <wf_id>");
      const wf = versionOf
        ? await call(env, "POST", `/api/workflows/${versionOf}/versions`, { commandId: newId("command"), definition: r.definition })
        : await call(env, "POST", "/api/workflows", { commandId: newId("command"), projectId, definition: r.definition });
      out.log(`registered ${wf.id} v${wf.version}`);
      return 0;
    }
    if (cmd === "project" && target) {
      const p = await call(env, "POST", "/api/projects", { commandId: newId("command"), name: target });
      out.log(`created project ${p.id}`);
      return 0;
    }
    out.error("usage: workflow validate <file> | submit <file> --project <id> | submit <file> --version-of <wf_id> | project <name>");
    return 2;
  } catch (err) {
    out.error((err as Error).message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(await main(process.argv.slice(2), process.env, { log: console.log, error: console.error }));
}
