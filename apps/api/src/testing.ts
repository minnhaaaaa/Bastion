import { ProviderConnections } from "./provider-connections";
/** Test-only harness: real server + PGlite + real services; runtime doubles are passed in by tests. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type RunLauncher, type TargetAudit } from "@bastion/contracts";
import { CommandStore, PgEventJournal, PgWorkflowRepository, ProjectRepository, RunRepository } from "@bastion/db";
import { createTestDb } from "@bastion/db/testing";
import { FsBlobStore, PgArtifactBroker } from "@bastion/provenance";
import { RecoveryManager } from "@bastion/recovery";
import { newSecret } from "./auth";
import { buildServer } from "./server";

export async function createTestApp(
  opts: { taskAttachments?: import("./task-attachments").TaskAttachmentStore; providerConfig?: { controller: import("@bastion/runtime-pi").PiConfig; key: string }; repositoryConnector?: import("./repository-access").RepositoryConnector; taskPlanner?: import("./task-planning").TaskPlanner; launcher?: RunLauncher; audit?: TargetAudit; briefingMs?: number; attackWindowMs?: number; reconnectGraceMs?: number; roomTtlMs?: number; joinRatePerMinute?: number; additionalOrigins?: string[] } = {},
) {
  const { db, close } = await createTestDb();
  const dir = await mkdtemp(join(tmpdir(), "bastion-api-"));
  const journal = new PgEventJournal(db);
  const runs = new RunRepository(db);
  const workflows = new PgWorkflowRepository(db);
  const broker = new PgArtifactBroker(journal, runs, new FsBlobStore(dir));
  const recovery = new RecoveryManager({ journal, locate: runs, workflows, approvalTtlMs: 60_000 });
  recovery.start();
  const providerConnections = opts.providerConfig ? new ProviderConnections(db, opts.providerConfig.controller, opts.providerConfig.key) : undefined;
  const tokenA = newSecret();
  const tokenB = newSecret();
  const userA = newId("user");
  const userB = newId("user");
  const { app, io, arena } = await buildServer(
    {
      db,
      providerConnections,
      journal,
      broker,
      recovery,
      projects: new ProjectRepository(db),
      workflows,
      runs,
      commands: new CommandStore(db),
      launcher: opts.launcher,
      taskPlanner: opts.taskPlanner,
      taskAttachments: opts.taskAttachments,
      repositoryConnector: opts.repositoryConnector,
      audit: opts.audit,
      operators: new Map([
        [tokenA, userA],
        [tokenB, userB],
      ]),
      config: {
        roomTtlMs: opts.roomTtlMs ?? 600_000,
        briefingMs: opts.briefingMs ?? 60_000,
        attackWindowMs: opts.attackWindowMs ?? 60_000,
        reconnectGraceMs: opts.reconnectGraceMs ?? 60_000,
        sweepIntervalMs: 3_600_000,
        joinRatePerMinute: opts.joinRatePerMinute ?? 1000,
        actionRatePerMinute: 1000,
      },
    },
    { webOrigin: "http://test.invalid", additionalOrigins: opts.additionalOrigins, logLevel: "silent" },
  );
  return {
    app,
    providerConnections,
    io,
    arena,
    db,
    journal,
    broker,
    recovery,
    userA,
    tokenA,
    tokenB,
    auth: (t: string) => ({ authorization: `Bearer ${t}` }),
    async close() {
      await app.close();
      recovery.stop();
      await recovery.idle();
      await close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Test-only generated workflow definition with one attack payload. */
export function testWorkflowDefinition() {
  const agent = newId("agent");
  const [t1, t2] = [newId("task"), newId("task")];
  const retryPolicy = { maxAttempts: 1, idempotent: true };
  return {
    name: `wf-${newId("trace").slice(-6)}`,
    agents: [{ id: agent, role: "RESEARCH" as const, capabilities: ["fs.read:/workspace/**"] }],
    sources: [
      { name: "doc", trust: "UNTRUSTED" as const, classification: "PUBLIC" as const, location: "/workspace/doc.md", fallbackSourceName: "doc-vetted" },
      { name: "doc-vetted", trust: "TRUSTED" as const, classification: "PUBLIC" as const, location: "/workspace/doc.vetted.md" },
    ],
    tasks: [
      { id: t1, agentId: agent, title: "one", declaredDeps: [], sourceNames: ["doc"], produces: "one", retryPolicy },
      { id: t2, agentId: agent, title: "two", declaredDeps: [t1], sourceNames: [], produces: "two", retryPolicy },
    ],
    policyRules: [],
    attackPayloads: [{ id: `atk-${newId("trace").slice(-6)}`, card: "POISON_DOCUMENT" as const, targetSourceName: "doc", label: "inject", contentLocation: "/attacks/a.md" }],
  };
}
