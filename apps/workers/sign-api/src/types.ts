import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';

/**
 * sign-api bindings: the kit's (auth, tenant DB, flags) plus only what
 * the sign module uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv {
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;
  /** Sent as x-internal-secret on every realtime-worker /publish/* call. */
  REALTIME_INTERNAL_SECRET?: string;
  /** WeldSign files (private bucket, `workspaces/<org>/weldsign/<envelopeId>/…`), ADR SIGN-004. */
  PRIVATE_STORAGE: R2Bucket;
}

export type Variables = KitVariables;
