import { expect, it } from "vitest";
import { ExecutionFence } from "./index";

it("serializes containment after an authorized side effect and releases locks on errors", async () => {
  const fence = new ExecutionFence(); const order: string[] = [];
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const first = fence.run("generated-execution", async () => { order.push("authorize"); await wait; order.push("execute"); });
  const hold = fence.run("generated-execution", async () => { order.push("hold"); });
  await fence.run("independent-execution", async () => { order.push("independent"); });
  expect(order).toEqual(["authorize", "independent"]);
  release(); await Promise.all([first, hold]);
  expect(order).toEqual(["authorize", "independent", "execute", "hold"]);
  await expect(fence.run("generated-execution", async () => { throw new Error("failure"); })).rejects.toThrow();
  await expect(fence.run("generated-execution", async () => "released")).resolves.toBe("released");
});
