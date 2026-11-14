/**
 * The workspace's quota state (`panel:quota:<workspace>`, written by panel-api's
 * usage settlement) as the collector reads it: from KV, remembered per isolate
 * for a minute, so a busy site costs one KV read per workspace and minute.
 * Missing, unreadable or unknown means `ok`: a KV hiccup must not drop events.
 */

import { parseQuotaState, quotaKvKey, type PanelQuotaState } from '@weldsuite/panel-domain/registry';

const TTL_MS = 60 * 1000;
/** Workspaces one isolate remembers; more than this and it starts over. */
const MAX_REMEMBERED = 5000;

const cache = new Map<string, { state: PanelQuotaState; at: number }>();

export async function quotaState(kv: KVNamespace, workspaceId: string, now: number): Promise<PanelQuotaState> {
  const cached = cache.get(workspaceId);
  if (cached && now - cached.at < TTL_MS) return cached.state;

  let state: PanelQuotaState = 'ok';
  try {
    state = parseQuotaState(await kv.get(quotaKvKey(workspaceId), { cacheTtl: 60 }));
  } catch (error) {
    console.error(`[panel-ingest] Quota lookup failed for workspace ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (cache.size >= MAX_REMEMBERED) cache.clear();
  cache.set(workspaceId, { state, at: now });
  return state;
}

/** Forgets the remembered states. Tests only: an isolate keeps them for a minute. */
export function resetQuotaCache(): void {
  cache.clear();
}
