/**
 * The OAuth `state`: a random single-use id in KV (`WORKSPACE_CACHE`,
 * `merge_oauth_state:<id>`, 600 s) holding who started the round trip and what
 * for. The provider hands the id back to the SPA callback page, which posts it
 * to `POST /oauth/callback`; the state's user and workspace must match the
 * caller, so a leaked id is useless to anyone else.
 */

import { ALPHANUMERIC, randomString } from '@weldsuite/worker-kit/random';
import {
  MERGE_OAUTH_STATE_TTL_SECONDS,
  mergeOauthStateSchema,
  type MergeOauthState,
} from '@weldsuite/app-api-client/schemas/weldmerge-providers';

export const stateKey = (id: string): string => `merge_oauth_state:${id}`;

/** Stores the state and returns its id (the value to put in the provider's `state` parameter). */
export async function createOAuthState(kv: KVNamespace, state: MergeOauthState): Promise<string> {
  const id = randomString(40, ALPHANUMERIC);
  await kv.put(stateKey(id), JSON.stringify(state), { expirationTtl: MERGE_OAUTH_STATE_TTL_SECONDS });
  return id;
}

/** Reads and removes the state (single use); null when it is unknown, expired or unreadable. */
export async function consumeOAuthState(kv: KVNamespace, id: string): Promise<MergeOauthState | null> {
  const raw = await kv.get(stateKey(id));
  if (!raw) return null;
  await kv.delete(stateKey(id));
  try {
    const parsed = mergeOauthStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
