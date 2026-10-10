const SECRET_KV = /\b(api[_-]?key|token|secret|password|passwd|authorization|bearer)\b\s*[:=]?\s*["']?[^\s"']+/gi;
const LONG_OPAQUE = /\b[A-Za-z0-9+/_=-]{32,}\b/g;
const URL_CREDENTIALS = /\/\/[^/\s:@]+:[^/\s@]+@/g;

/**
 * Safe-to-broadcast preview: secret-looking values removed, whitespace collapsed, truncated.
 * Full content stays behind its blobRef and never enters events (ARCHITECTURE §7).
 */
export function redactText(content: string | Uint8Array): string {
  const text = typeof content === "string" ? content : new TextDecoder().decode(content);
  return text
    .replace(URL_CREDENTIALS, "//[redacted]@")
    .replace(SECRET_KV, (_m, k: string) => `${k}=[redacted]`)
    .replace(LONG_OPAQUE, "[redacted]");
}

export function redactPreview(content: string | Uint8Array, max = 200): string {
  const cleaned = redactText(content).replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}
