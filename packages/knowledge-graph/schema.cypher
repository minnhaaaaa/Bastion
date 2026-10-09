// SPLITBRAIN knowledge graph schema (ARCHITECTURE §6.1). Apply once at startup (idempotent).
// Projection only: written by the backend projector from committed events, never by clients.
//
// Edge direction: all provenance edges point DOWNSTREAM (data-flow) — see contracts/src/reduce.ts.
//   (Agent)-[:EXECUTED]->(TaskExecution)
//   (Source|ArtifactVersion)-[:CONSUMED]->(TaskExecution)        "was consumed by"
//   (TaskExecution)-[:PRODUCED]->(ArtifactVersion)
//   (Source|ArtifactVersion)-[:DERIVED_FROM]->(ArtifactVersion)  "is an origin of"
//   (TaskExecution)-[:REQUESTED]->(ToolCall)
//   (ToolCall)-[:TARGETED]->(Resource)
//   (ToolCall)-[:GOVERNED_BY]->(Policy)
//   (Source|ArtifactVersion|ToolCall)-[:FLAGGED_IN]->(SecurityIncident)
//   (TaskExecution)-[:DEPENDS_ON]->(TaskExecution)               upstream → downstream; derived from the
//       logical TaskSpec-level DEPENDS_ON rows in dependency_edges (fromType 'TaskSpec')
// Every node and relationship carries: id, runId, sourceEventId (+ seq).

CREATE CONSTRAINT agent_id IF NOT EXISTS FOR (n:Agent) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT task_execution_id IF NOT EXISTS FOR (n:TaskExecution) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT source_id IF NOT EXISTS FOR (n:Source) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT artifact_version_id IF NOT EXISTS FOR (n:ArtifactVersion) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT tool_call_id IF NOT EXISTS FOR (n:ToolCall) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT resource_id IF NOT EXISTS FOR (n:Resource) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT policy_id IF NOT EXISTS FOR (n:Policy) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT security_incident_id IF NOT EXISTS FOR (n:SecurityIncident) REQUIRE n.id IS UNIQUE;

CREATE INDEX task_execution_run IF NOT EXISTS FOR (n:TaskExecution) ON (n.runId);
CREATE INDEX artifact_version_run IF NOT EXISTS FOR (n:ArtifactVersion) ON (n.runId);
CREATE INDEX source_run IF NOT EXISTS FOR (n:Source) ON (n.runId);

// Projector bookkeeping: highest applied seq per run (for the consistency rule).
CREATE CONSTRAINT projection_cursor_run IF NOT EXISTS FOR (n:ProjectionCursor) REQUIRE n.runId IS UNIQUE;

// Impact set (illustrative; vetted relations only, runId-scoped):
// MATCH (s:Source {id: $sourceId, runId: $runId})-[:CONSUMED|PRODUCED|DERIVED_FROM*1..]->(x)
// WHERE x.runId = $runId
// RETURN DISTINCT labels(x)[0] AS label, x.id AS id
