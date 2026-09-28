import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';

/**
 * ads-api bindings: the kit's (auth, tenant DB, flags) plus only what
 * the ads module uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv {
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;

  /** Absolute base URL for links in notification emails / push payloads,
   *  e.g. `https://app.weldsuite.org`. */
  PUBLIC_APP_URL?: string;

  // --- WeldAds (Meta Marketing API) --------------------------------------
  FACEBOOK_APP_ID?: string;
  FACEBOOK_APP_SECRET?: string;
}

export type Variables = KitVariables;
