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
  /** Outbound customer webhooks (Phase 3) → entity-webhooks* → integration-webhook-worker. */
  SUB_WEBHOOKS: Queue<EntityEventMessage>;
  /** Optional until later phases register these subscribers. */
  SUB_WELDCONNECT?: Queue<EntityEventMessage>;
  SUB_WELDAGENT?: Queue<EntityEventMessage>;
  SUB_REALTIME?: Queue<EntityEventMessage>;
}

export type SubscriberQueueEnv = Pick<
  Env,
  EntityEventSubscriberQueueBinding
>;
