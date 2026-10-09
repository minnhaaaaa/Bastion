import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  WorkflowDefinition,
  newId,
  type Project,
  type RunSummary,
  type Workflow,
  type WorkflowRepository,
} from "@bastion/contracts";
import type { Db } from "./client";
import * as t from "./schema";
import { toIso } from "./journal";

export class ProjectRepository {
  constructor(private readonly db: Db) {}

  async create(ownerId: string, name: string): Promise<Project> {
    const row = { id: newId("project"), ownerId, name, policySetId: null };
    await this.db.insert(t.projects).values(row);
    return row;
  }

  async get(id: string): Promise<Project | null> {
    const [r] = await this.db.select().from(t.projects).where(eq(t.projects.id, id));
    return r ? { id: r.id, ownerId: r.ownerId, name: r.name, policySetId: r.policySetId } : null;
  }

  async listByOwner(ownerId: string): Promise<Project[]> {
    const rows = await this.db.select().from(t.projects).where(eq(t.projects.ownerId, ownerId)).orderBy(desc(t.projects.createdAt));
    return rows.map((r) => ({ id: r.id, ownerId: r.ownerId, name: r.name, policySetId: r.policySetId }));
  }
}

const toWorkflow = (r: typeof t.workflows.$inferSelect): Workflow => ({
  id: r.id,
  projectId: r.projectId,
  version: r.version,
  definition: WorkflowDefinition.parse(r.definition),
  createdAt: toIso(r.createdAt),
});

export class PgWorkflowRepository implements WorkflowRepository {
  constructor(private readonly db: Db) {}

  async create(projectId: string, definition: WorkflowDefinition): Promise<Workflow> {
    const def = WorkflowDefinition.parse(definition);
    const [r] = await this.db
      .insert(t.workflows)
      .values({ id: newId("workflow"), version: 1, projectId, definition: def })
      .returning();
    return toWorkflow(r!);
  }

  /** Appends a new immutable version; existing runs keep pointing at the version they started with. */
  async createVersion(workflowId: string, definition: WorkflowDefinition): Promise<Workflow | null> {
    const def = WorkflowDefinition.parse(definition);
    return this.db.transaction(async (tx) => {
      const [latest] = await tx
        .select()
        .from(t.workflows)
        .where(eq(t.workflows.id, workflowId))
        .orderBy(desc(t.workflows.version))
        .limit(1);
      if (!latest) return null;
      const [r] = await tx
        .insert(t.workflows)
        .values({ id: workflowId, version: latest.version + 1, projectId: latest.projectId, definition: def })
        .returning();
      return toWorkflow(r!);
    });
  }

  async get(workflowId: string): Promise<Workflow | null> {
    const [r] = await this.db
      .select()
      .from(t.workflows)
      .where(eq(t.workflows.id, workflowId))
      .orderBy(desc(t.workflows.version))
      .limit(1);
    return r ? toWorkflow(r) : null;
  }

  async getVersion(workflowId: string, version: number): Promise<Workflow | null> {
    const [r] = await this.db
      .select()
      .from(t.workflows)
      .where(and(eq(t.workflows.id, workflowId), eq(t.workflows.version, version)));
    return r ? toWorkflow(r) : null;
  }

  /** Latest version of each workflow in the project. */
  async list(projectId: string): Promise<Workflow[]> {
    const rows = await this.db
      .selectDistinctOn([t.workflows.id])
      .from(t.workflows)
      .where(eq(t.workflows.projectId, projectId))
      .orderBy(t.workflows.id, desc(t.workflows.version));
    return rows.map(toWorkflow);
  }
}

export class RunRepository {
  constructor(private readonly db: Db) {}

  async list(projectIds: string[]): Promise<RunSummary[]> {
    if (projectIds.length === 0) return [];
    const rows = await this.db
      .select({
        id: t.runs.id,
        workflowId: t.runs.workflowId,
        mode: t.runs.mode,
        status: t.runs.status,
        startedAt: t.runs.startedAt,
        openIncidents: sql<number>`(select count(*)::int from ${t.securityIncidents} i where i.run_id = ${t.runs.id} and i.state not in ('RESOLVED'))`,
      })
      .from(t.runs)
      .where(inArray(t.runs.projectId, projectIds))
      .orderBy(desc(t.runs.startedAt));
    return rows.map((r) => ({ ...r, startedAt: r.startedAt ? toIso(r.startedAt) : null, openIncidents: Number(r.openIncidents) }));
  }

  async projectOf(runId: string): Promise<string | null> {
    const [r] = await this.db.select({ projectId: t.runs.projectId }).from(t.runs).where(eq(t.runs.id, runId));
    return r?.projectId ?? null;
  }

  /** Run that owns a source/artifact version (used by the broker for id-only lookups). */
  async runOfVersion(versionId: string): Promise<string | null> {
    const table = versionId.startsWith("src_") ? t.sourceVersions : t.artifactVersions;
    const [r] = await this.db.select({ runId: table.runId }).from(table).where(eq(table.id, versionId));
    return r?.runId ?? null;
  }

  async runOfApproval(approvalId: string): Promise<string | null> {
    const [r] = await this.db
      .select({ runId: t.securityIncidents.runId })
      .from(t.approvalRequests)
      .innerJoin(t.securityIncidents, eq(t.approvalRequests.incidentId, t.securityIncidents.id))
      .where(eq(t.approvalRequests.id, approvalId));
    return r?.runId ?? null;
  }

  async runOfIncident(incidentId: string): Promise<string | null> {
    const [r] = await this.db
      .select({ runId: t.securityIncidents.runId })
      .from(t.securityIncidents)
      .where(eq(t.securityIncidents.id, incidentId));
    return r?.runId ?? null;
  }
}

export type StoredCommand = { status: number; body: unknown };

/** commandId → first result. Replays return the stored result; a different actor gets a conflict. */
export class CommandStore {
  constructor(private readonly db: Db) {}

  async get(commandId: string): Promise<(StoredCommand & { actorId: string; route: string }) | null> {
    const [r] = await this.db.select().from(t.commandResults).where(eq(t.commandResults.commandId, commandId));
    return r ? { status: r.status, body: r.body, actorId: r.actorId, route: r.route } : null;
  }

  async put(commandId: string, actorId: string, route: string, result: StoredCommand): Promise<void> {
    await this.db
      .insert(t.commandResults)
      .values({ commandId, actorId, route, status: result.status, body: result.body as object })
      .onConflictDoNothing();
  }
}
