/**
 * @bastion/runtime-adapter — owner: Member 2
 * Framework-neutral AgentRuntimeAdapter (types live in contracts/ports.ts) + in-memory fake for tests.
 * See TEAM_PLAN.md and packages/contracts/src/ports.ts.
 */
export type { AgentRuntimeAdapter, AgentRunRequest, RuntimeEvent } from "@bastion/contracts";

/** Shared by tool dispatch and containment; covers authorization through side effect. */
export class ExecutionFence {
  private readonly tails = new Map<string, Promise<void>>();
  async run<T>(executionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(executionId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    this.tails.set(executionId, tail);
    await previous;
    try { return await operation(); }
    finally { release(); if (this.tails.get(executionId) === tail) this.tails.delete(executionId); }
  }
}
