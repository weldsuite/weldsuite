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
  /** WeldConnect entity_event triggers (Phase 4) → entity-workflows* → workflow-worker. */
  SUB_WELDCONNECT: Queue<EntityEventMessage>;
  /** WeldAgent eventSubscriptions (Phase 5) → entity-agents* → app-api. */
  SUB_WELDAGENT: Queue<EntityEventMessage>;
  /** Realtime WorkspaceHub bridge (Phase 6) → entity-realtime* → realtime-worker. */
  SUB_REALTIME: Queue<EntityEventMessage>;
}

export type SubscriberQueueEnv = Pick<
  Env,
  EntityEventSubscriberQueueBinding
>;
