import { describe, expect, it } from "vitest";
import { buildServer } from "./server";
import { loadEnv } from "./env";

describe("api", () => {
  it("GET /health reports live server time", async () => {
    const { app, io } = await buildServer({ webOrigin: "http://test.invalid", logLevel: "silent" });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(Date.parse(body.now)).not.toBeNaN();
    io.close();
    await app.close();
  });

  it("refuses to start without required config", () => {
    expect(() => loadEnv({})).toThrow(/API_PORT/);
  });
});
