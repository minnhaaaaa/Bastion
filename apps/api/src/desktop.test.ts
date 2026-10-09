import { expect, it } from "vitest";
import { createTestApp } from "./testing";
it("accepts only explicit desktop origins and retains operator authentication", async () => {
  const origin = `https://${crypto.randomUUID()}.invalid`;
  const test = await createTestApp({ additionalOrigins: [origin] });
  try {
    const allowed = await test.app.inject({ url: "/health", headers: { origin } });
    expect(allowed.headers["access-control-allow-origin"]).toBe(origin);
    const untrusted = await test.app.inject({ url: "/health", headers: { origin: `https://${crypto.randomUUID()}.invalid` } });
    expect(untrusted.headers["access-control-allow-origin"]).toBeUndefined();
    const anonymous = await test.app.inject({ url: "/api/projects", headers: { origin } });
    expect(anonymous.statusCode).toBe(401);
    const operator = await test.app.inject({ url: "/api/projects", headers: { origin, ...test.auth(test.tokenA) } });
    expect(operator.statusCode).toBe(200);
  } finally { await test.close(); }
});
