import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';

/**
 * merge-api bindings: the kit's (auth, tenant DB, flags) plus only what
 * the merge module uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv {
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;
  /** Sent as x-internal-secret on every realtime-worker /publish/* call. */
  REALTIME_INTERNAL_SECRET?: string;
  /** The WeldSuite GitHub App (the same one connect-api uses): installation tokens are minted per call. */
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
}

export type Variables = KitVariables & {
  /** Set by the `MergeInternal` entrypoint: the caller is another worker over a service binding. */
  internalTrusted?: boolean;
};
