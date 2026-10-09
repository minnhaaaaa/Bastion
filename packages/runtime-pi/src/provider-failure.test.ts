import { expect, it } from "vitest";
import { providerFailureCode } from "./provider-failure";
it("classifies quota and authentication failures without exposing provider text", () => {
  const privateValue = crypto.randomUUID();
  expect(providerFailureCode(`429 Rate limit exceeded: free-models-per-day ${privateValue}`)).toBe("PROVIDER_RATE_LIMITED");
  expect(providerFailureCode(`401 Invalid API key: ${privateValue}`)).toBe("PROVIDER_AUTH_FAILED");
  expect(providerFailureCode(`Unexpected upstream response: ${privateValue}`)).toBe("ERROR");
  expect(providerFailureCode(undefined)).toBe("ERROR");
});
