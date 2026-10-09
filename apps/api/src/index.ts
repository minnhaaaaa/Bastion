import { CommandStore, PgEventJournal, PgWorkflowRepository, ProjectRepository, RunRepository, createDb } from "@bastion/db";
import { FsBlobStore, PgArtifactBroker } from "@bastion/provenance";
import { RecoveryManager } from "@bastion/recovery";
import { Neo4jProjector, loadSchemaStatements } from "@bastion/knowledge-graph";
import type { RecoveryVerifier, RunLauncher, Scheduler, TargetAudit } from "@bastion/contracts";
import { loadEnv } from "./env";
import { buildServer } from "./server";

const env = loadEnv();
const pg = createDb(env.DATABASE_URL);
await pg.migrate();

const journal = new PgEventJournal(pg.db, (err, e) => console.error(`listener failed on ${e.type}#${e.seq}`, err));
const runs = new RunRepository(pg.db);
const workflows = new PgWorkflowRepository(pg.db);
const broker = new PgArtifactBroker(journal, runs, new FsBlobStore(env.BLOB_DIR));

// Knowledge graph: required by the architecture, but never on the containment critical path.
const graph = new Neo4jProjector(Neo4jProjector.connect(env.NEO4J_URI, env.NEO4J_USER, env.NEO4J_PASSWORD), journal, (m, e) =>
  console.error(m, e),
);
await graph.start(await loadSchemaStatements());

// ── Agent runtime (Member 2) ─────────────────────────────────────────────────
// Wire the real implementations here once they exist. Until then they stay undefined and the
// API reports runtimeConnected=false (runs/rooms return 503). Never substitute fakes in this file.
const runtime: { launcher?: RunLauncher; scheduler?: Scheduler; verifier?: RecoveryVerifier; audit?: TargetAudit } = {};

const recovery = new RecoveryManager({
  journal,
  locate: runs,
  workflows,
  scheduler: runtime.scheduler,
  verifier: runtime.verifier,
  graph,
  approvalTtlMs: env.APPROVAL_TTL_SECONDS * 1000,
  log: (m, e) => console.error(m, e),
});
recovery.start();

const { app } = await buildServer(
  {
    db: pg.db,
    journal,
    broker,
    recovery,
    projects: new ProjectRepository(pg.db),
    workflows,
    runs,
    commands: new CommandStore(pg.db),
    launcher: runtime.launcher,
    audit: runtime.audit,
    graph,
    operators: env.OPERATOR_TOKENS,
    config: {
      roomTtlMs: env.ROOM_TTL_SECONDS * 1000,
      briefingMs: env.ARENA_BRIEFING_SECONDS * 1000,
      attackWindowMs: env.ARENA_ATTACK_WINDOW_SECONDS * 1000,
    },
  },
  { webOrigin: env.WEB_ORIGIN, logLevel: env.LOG_LEVEL },
);

const shutdown = async () => {
  await app.close();
  recovery.stop();
  await recovery.idle();
  await graph.stop();
  await pg.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
