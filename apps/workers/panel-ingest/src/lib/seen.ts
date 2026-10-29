/**
 * `panel:seen:<project>`: when the collector last accepted an event for a
 * project, read by panel-api for the install check ("events seen in the last
 * 24 hours"). Written at most once per five minutes per isolate and project,
 * so a busy site does not turn into a KV write per request.
 */

import { seenKvKey } from '@weldsuite/panel-domain/registry';

const INTERVAL_MS = 5 * 60 * 1000;
const TTL_SECONDS = 90 * 24 * 60 * 60;
/** Projects one isolate remembers; more than this and it starts over, which costs a few extra writes. */
const MAX_REMEMBERED = 2000;

const lastWritten = new Map<string, number>();

export async function touchSeen(kv: KVNamespace, projectId: string, now: number): Promise<void> {
  const last = lastWritten.get(projectId);
  if (last !== undefined && now - last < INTERVAL_MS) return;

  if (lastWritten.size >= MAX_REMEMBERED) lastWritten.clear();
  lastWritten.set(projectId, now);
  try {
    await kv.put(seenKvKey(projectId), new Date(now).toISOString(), { expirationTtl: TTL_SECONDS });
  } catch (error) {
    lastWritten.delete(projectId);
    throw error;
  }
}

/** Forgets what was written. Tests only: an isolate keeps it. */
export function resetSeenThrottle(): void {
  lastWritten.clear();
}
