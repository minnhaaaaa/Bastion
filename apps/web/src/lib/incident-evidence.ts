/** Bounded, redacted excerpt recorded after the controller checks it against the source. */
export function incidentEvidence(reason: string): { explanation: string; excerpt: string | null } {
  const marker = "\nSuspected text (redacted): ";
  const index = reason.lastIndexOf(marker);
  if (index < 0) return { explanation: reason, excerpt: null };
  try {
    const excerpt: unknown = JSON.parse(reason.slice(index + marker.length));
    if (typeof excerpt === "string" && excerpt.trim()) return { explanation: reason.slice(0, index), excerpt };
  } catch { /* Older or manually entered incident reasons need no inferred excerpt. */ }
  return { explanation: reason, excerpt: null };
}
