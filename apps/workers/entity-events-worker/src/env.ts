import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { EntityEventSubscriberQueueBinding } from '@weldsuite/entity-events';

/**
 * Env for the entity-events hub worker.
 * Only queue bindings — no DB / REALTIME / Workflow business logic.
 */
export interface Env {
  ENVIRONMENT: string;
  SUB_AUDIT: Queue<EntityEventMessage>;
  SUB_ANALYTICS: Queue<EntityEventMessage>;
  SUB_SEARCH: Queue<EntityEventMessage>;
  /** Optional until later phases register these subscribers. */
  SUB_WEBHOOKS?: Queue<EntityEventMessage>;
  SUB_WELDCONNECT?: Queue<EntityEventMessage>;
  SUB_WELDAGENT?: Queue<EntityEventMessage>;
  SUB_REALTIME?: Queue<EntityEventMessage>;
}

export type SubscriberQueueEnv = Pick<
  Env,
  EntityEventSubscriberQueueBinding
>;
