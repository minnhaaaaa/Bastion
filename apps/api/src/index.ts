import { ChatGPTAuth } from "./chatgpt-auth";
import { CommandStore, PgEventJournal, PgWorkflowRepository, ProjectRepository, RunRepository, createDb } from "@bastion/db";
import { FsBlobStore, PgArtifactBroker } from "@bastion/provenance";
import { RecoveryManager } from "@bastion/recovery";
import { Neo4jProjector, loadSchemaStatements } from "@bastion/knowledge-graph";
import { loadEnv } from "./env";
import { buildAgentRuntime } from "./runtime";
import { reconcileOnBoot } from "./reconcile";
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

// ── Agent runtime (Member 2: Pi + gateway + sandbox + scheduler + runner) ─────
// Enabled only by explicit configuration; never substituted with fakes.
const runtime = env.AGENT_RUNTIME === "enabled" ? buildAgentRuntime({ env: process.env, db: pg.db, journal, broker, workflows }) : undefined;
if (!runtime) console.warn("AGENT_RUNTIME=disabled: runs and arena rounds cannot start");

const recovery = new RecoveryManager({
  journal,
  locate: runs,
  workflows,
  scheduler: runtime?.scheduler,
  verifier: runtime?.verifier,
  fence: runtime?.fence,
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
    launcher: runtime?.launcher,
    providerConnections: runtime?.providerConnections,
    chatgptAuth: runtime?.providerConnections ? ChatGPTAuth.fromEnv(process.env, runtime.providerConnections) : undefined,
    taskPlanner: runtime?.taskPlanner,
    taskAttachments: runtime?.taskAttachments,
    repositoryConnector: runtime?.repositoryConnector,
    runtimeInfo: runtime?.info,
    toolApprovals: runtime?.toolApprovals,
    audit: runtime?.audit,
    graph,
    operators: env.OPERATOR_TOKENS,
    config: {
      roomTtlMs: env.ROOM_TTL_SECONDS * 1000,
      briefingMs: env.ARENA_BRIEFING_SECONDS * 1000,
      attackWindowMs: env.ARENA_ATTACK_WINDOW_SECONDS * 1000,
      reconnectGraceMs: env.ARENA_RECONNECT_GRACE_SECONDS * 1000,
      sweepIntervalMs: env.ARENA_SWEEP_SECONDS * 1000,
      joinRatePerMinute: env.ARENA_JOIN_RATE_PER_MINUTE,
      actionRatePerMinute: env.ARENA_ACTION_RATE_PER_MINUTE,
    },
  },
  { webOrigin: env.WEB_ORIGIN, additionalOrigins: env.WEB_ADDITIONAL_ORIGINS, logLevel: env.LOG_LEVEL },
);

// Close out work that was in flight before this process started (listeners are attached now).
const reconciled = await reconcileOnBoot({ db: pg.db, journal, scheduler: runtime?.scheduler });
if (reconciled.failedRuns.length || reconciled.adopted.length || reconciled.expiredToolApprovals.length) console.warn("boot reconciliation", reconciled);

const shutdown = async () => {
  await app.close();
  runtime?.toolApprovals.stop();
  recovery.stop();
  await recovery.idle();
  await graph.stop();
  await pg.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
