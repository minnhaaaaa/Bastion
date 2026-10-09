/** Public failure categories only. Never forward raw provider errors or credential details. */
export function providerFailureCode(message: string | undefined): string {
  if (!message) return "ERROR";
  if (/\b429\b|rate[ -]?limit|quota.{0,30}(?:exceeded|exhausted)|insufficient.{0,20}credits/i.test(message)) return "PROVIDER_RATE_LIMITED";
  if (/\b(?:401|403)\b|invalid.{0,20}(?:api[ -]?key|credential)|unauthorized/i.test(message)) return "PROVIDER_AUTH_FAILED";
  return "ERROR";
}
