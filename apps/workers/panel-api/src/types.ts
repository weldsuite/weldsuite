import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';

/**
 * panel-api bindings: the kit's (auth, tenant DB, flags) plus only what
 * the panel module uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv {
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;
  /** Sent as x-internal-secret on every realtime-worker /publish/* call. */
  REALTIME_INTERNAL_SECRET?: string;
}

export type Variables = KitVariables;
