/**
 * One log line per problem per isolate: a missing optional binding (a stream
 * not created yet, the replays bucket) must be visible without a line per
 * request on a busy site.
 */

const warned = new Set<string>();

export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[panel-ingest] ${message}`);
}

/** Forgets what was warned about. Tests only: an isolate keeps it. */
export function resetWarnings(): void {
  warned.clear();
}
