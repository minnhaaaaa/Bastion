import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema, PgWorkflowRepository, type Db } from "@bastion/db";
import { piModelCatalog, piModelRegistry, type PiConfig } from "@bastion/runtime-pi";
import type { Workflow } from "@bastion/contracts";
import { HttpError } from "./errors";

export type ProviderSecret = { kind: "api-key"; apiKey: string } | { kind: "chatgpt"; accessToken: string; refreshToken: string; expiresAt: number; clientId: string; subject: string; idToken: string; scopes: string[] };
export type ConnectionRow = typeof schema.providerConnections.$inferSelect;
export class ProviderConnections {
  private key: Buffer;
  refresh?: (secret: Extract<ProviderSecret, { kind: "chatgpt" }>) => Promise<ProviderSecret>;
  private refreshes = new Map<string, Promise<ProviderSecret>>();
  constructor(readonly db: Db, readonly controller: PiConfig, key: string) {
    if (!/^[a-f\d]{64}$/i.test(key)) throw new Error("PROVIDER_CREDENTIAL_KEY must contain 32 bytes encoded as hex");
    this.key = Buffer.from(key, "hex");
  }
  seal(secret: ProviderSecret, owner: string, id: string) {
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify([owner, id])));
    const content = Buffer.concat([cipher.update(JSON.stringify(secret), "utf8"), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), content]).toString("base64");
  }
  open(row: ConnectionRow): ProviderSecret {
    try {
      const bytes = Buffer.from(row.credential, "base64");
      const cipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
      cipher.setAAD(Buffer.from(JSON.stringify([row.ownerId, row.id]))); cipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8"));
    } catch { throw new HttpError("UNAVAILABLE", "Provider credentials could not be opened. Reconnect this provider."); }
  }
  public(row: ConnectionRow) { return { id: row.id, label: row.label, provider: row.provider, model: row.model, authMode: row.authMode, disabled: row.disabled, createdAt: row.createdAt }; }
  async list(owner: string) { return (await this.db.select().from(schema.providerConnections).where(eq(schema.providerConnections.ownerId, owner))).map(row => this.public(row)); }
  async own(owner: string, id: string) {
    const [row] = await this.db.select().from(schema.providerConnections).where(and(eq(schema.providerConnections.id, id), eq(schema.providerConnections.ownerId, owner)));
    if (!row) throw new HttpError("NOT_FOUND", "Provider connection not found");
    if (row.disabled) throw new HttpError("CONFLICT", "Provider connection is disconnected");
    return row;
  }
  async save(owner: string, label: string, config: Pick<PiConfig, "provider" | "model" | "baseUrl" | "customModel">, secret: ProviderSecret) {
    const id = randomUUID();
    const [row] = await this.db.insert(schema.providerConnections).values({ id, ownerId: owner, label, provider: config.provider, model: config.model, baseUrl: config.baseUrl, authMode: secret.kind, credential: this.seal(secret, owner, id), metadata: config.customModel ?? null }).returning();
    return this.public(row!);
  }
  async addApiKey(owner: string, label: string, provider: string, model: string, apiKey: string) {
    const entry = piModelCatalog().find(item => item.provider === provider && item.id === model);
    if (!entry) throw new HttpError("VALIDATION", "Choose a model from the installed provider catalog");
    piModelRegistry({ ...this.controller, ...entry, model, authMode: "api-key", apiKey, customModel: undefined });
    return this.save(owner, label, { ...entry, model }, { kind: "api-key", apiKey });
  }
  async importController(owner: string, label: string) {
    if (this.controller.authMode !== "api-key") throw new HttpError("CONFLICT", "Connect your ChatGPT account directly");
    return this.save(owner, label, this.controller, { kind: "api-key", apiKey: this.controller.apiKey });
  }
  async config(owner: string, id: string): Promise<PiConfig> {
    const row = await this.own(owner, id);
    let secret = this.open(row);
    if (secret.kind === "chatgpt" && secret.expiresAt <= Date.now()) {
      if (!this.refresh) throw new HttpError("UNAVAILABLE", "Reconnect your ChatGPT account");
      let pending = this.refreshes.get(id);
      if (!pending) {
        pending = (async () => {
          const current = this.open(await this.own(owner, id));
          if (current.kind !== "chatgpt") throw new Error("Account type changed");
          return current.expiresAt > Date.now() ? current : this.refresh!(current);
        })().then(async updated => {
          await this.db.update(schema.providerConnections).set({ credential: this.seal(updated, owner, id) }).where(and(eq(schema.providerConnections.id, id), eq(schema.providerConnections.disabled, false))); return updated;
        }).finally(() => this.refreshes.delete(id));
        this.refreshes.set(id, pending);
      }
      try { secret = await pending; }
      catch { throw new HttpError("UNAVAILABLE", "ChatGPT session could not be renewed. Connect your account again."); }
    }
    await this.own(owner, id);
    return { ...this.controller, provider: row.provider, model: row.model, baseUrl: row.baseUrl, authMode: "api-key", apiKey: secret.kind === "api-key" ? secret.apiKey : secret.accessToken, customModel: row.metadata ? row.metadata as PiConfig["customModel"] : undefined };
  }
  async projectDefault(projectId: string) { const [row] = await this.db.select().from(schema.projectModels).where(eq(schema.projectModels.projectId, projectId)); return row?.connectionId ?? null; }
  async disable(owner: string, id: string) {
    await this.own(owner, id);
    await this.db.update(schema.providerConnections).set({ disabled: true, credential: "" }).where(and(eq(schema.providerConnections.id, id), eq(schema.providerConnections.ownerId, owner)));
  }
  async saveWorkflow(owner: string, projectId: string, definition: Workflow["definition"], selection: { connectionId?: string; agentConnections?: Record<string, string> }, previous?: Workflow) {
    const inherited = previous ? await this.bindings(previous.id, previous.version) : {};
    const connectionId = selection.connectionId ?? await this.projectDefault(projectId);
    const bindings: Record<string, string> = {};
    for (const agent of definition.agents) {
      const id = selection.agentConnections?.[agent.id] ?? selection.connectionId ?? inherited[agent.id] ?? connectionId;
      if (!id) throw new HttpError("VALIDATION", "Choose a project model in Connections before saving a workflow");
      bindings[agent.id] = id;
    }
    await this.validateBindings(owner, definition, selection.agentConnections ?? {});
    await this.validateBindings(owner, definition, bindings);
    return this.db.transaction(async tx => {
      const repo = new PgWorkflowRepository(tx as unknown as Db);
      const workflow = previous ? await repo.createVersion(previous.id, definition) : await repo.create(projectId, definition);
      if (!workflow) throw new HttpError("NOT_FOUND", "Workflow not found");
      await tx.insert(schema.workflowModels).values({ workflowId: workflow.id, version: workflow.version, bindings });
      return workflow;
    });
  }
  async bindings(workflowId: string, version: number) { const [row] = await this.db.select().from(schema.workflowModels).where(and(eq(schema.workflowModels.workflowId, workflowId), eq(schema.workflowModels.version, version))); return row?.bindings ?? {}; }
  async validateBindings(owner: string, workflow: Workflow["definition"], bindings: Record<string, string>) {
    if (Object.keys(bindings).some(id => !workflow.agents.some(agent => agent.id === id))) throw new HttpError("VALIDATION", "Model assignment references an unknown agent");
    for (const id of new Set(Object.values(bindings))) await this.own(owner, id);
  }
  async forExecution(workflow: Workflow, agentId: string): Promise<PiConfig> {
    const bindings = await this.bindings(workflow.id, workflow.version);
    const id = bindings[agentId];
    if (!id && Object.keys(bindings).length) throw new HttpError("CONFLICT", "The workflow is missing an agent model assignment");
    if (!id) return this.controller; // Legacy workflows explicitly retain the controller configuration.
    const [project] = await this.db.select().from(schema.projects).where(eq(schema.projects.id, workflow.projectId));
    if (!project) throw new Error("Project missing for provider connection");
    return this.config(project.ownerId, id);
  }
}
