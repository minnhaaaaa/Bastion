import { describe, expect, it } from "vitest";
import { createTestDb } from "./testing";
import { projects } from "./schema";

describe("db", () => {
  it("migrations apply and tables are usable", async () => {
    const { db, close } = await createTestDb();
    await db.insert(projects).values({ id: "proj_x", ownerId: "user_x", name: "p", policySetId: null });
    expect(await db.select().from(projects)).toHaveLength(1);
    await close();
  });
});
