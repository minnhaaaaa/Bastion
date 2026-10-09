import { describe, expect, it } from "vitest";
import { buildServer } from "./server";

describe("api", () => {
  it("GET /health", async () => {
    const { app, io } = await buildServer({ webOrigin: "http://localhost:5173" });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, service: "splitbrain-api" });
    io.close();
    await app.close();
  });
});
