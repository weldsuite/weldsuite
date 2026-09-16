/**
 * Static first-party subscriber registry for the entity-events hub.
 *
 * Phase 1–2: audit / analytics / search-index.
 * Phase 3: webhooks.
 * Phase 4: WeldConnect.
 * Later: WeldAgent, realtime.
 *
 * Topic patterns (v1):
 *   - `*`                  — all events
 *   - `entityType:*`       — all actions for an entity
 *   - `entityType:action`  — exact match
 */

export type EntityEventTopicPattern = '*' | `${string}:*` | `${string}:${string}`;

export type EntityEventSubscriberQueueBinding =
  | 'SUB_AUDIT'
  | 'SUB_ANALYTICS'
  | 'SUB_SEARCH'
  | 'SUB_WEBHOOKS'
  | 'SUB_WELDCONNECT'
  | 'SUB_WELDAGENT'
  | 'SUB_REALTIME';

export interface EntityEventSubscriber {
  /** Stable id used in logs / metrics. */
  id: string;
  /** Topic filters evaluated with {@link topicMatches}. */
  topics: readonly EntityEventTopicPattern[];
  /** Cloudflare Queue producer binding name on the hub worker. */
  queueBinding: EntityEventSubscriberQueueBinding;
}

/**
 * Validate and freeze a subscriber list. Throws on empty topics or duplicate ids.
 */
export function defineEntityEventSubscribers<const T extends readonly EntityEventSubscriber[]>(
  subscribers: T,
): T {
  const seen = new Set<string>();
  for (const sub of subscribers) {
    if (!sub.id) {
      throw new Error('[EntityEvents] subscriber id is required');
    }
    if (seen.has(sub.id)) {
      throw new Error(`[EntityEvents] duplicate subscriber id: ${sub.id}`);
    }
    seen.add(sub.id);
    if (!sub.topics.length) {
      throw new Error(`[EntityEvents] subscriber ${sub.id} must declare at least one topic`);
    }
    if (!sub.queueBinding) {
      throw new Error(`[EntityEvents] subscriber ${sub.id} must declare a queueBinding`);
    }
  }
  return subscribers;
}

/**
 * Return true when `eventType` (`entityType:action`) matches any pattern.
 */
export function topicMatches(
  patterns: readonly EntityEventTopicPattern[] | readonly string[],
  eventType: string,
): boolean {
  const colon = eventType.indexOf(':');
  if (colon <= 0 || colon === eventType.length - 1) {
    return false;
  }
  const entityType = eventType.slice(0, colon);

  for (const pattern of patterns) {
    if (pattern === '*') return true;
    if (pattern === eventType) return true;
    if (pattern.endsWith(':*')) {
      const prefix = pattern.slice(0, -2);
      if (prefix === entityType) return true;
    }
  }
  return false;
}

/** Subscribers that receive copies from the hub in Phase 1+. */
export const ENTITY_EVENT_SUBSCRIBERS = defineEntityEventSubscribers([
  { id: 'audit', topics: ['*'], queueBinding: 'SUB_AUDIT' },
  { id: 'analytics', topics: ['*'], queueBinding: 'SUB_ANALYTICS' },
  { id: 'search-index', topics: ['*'], queueBinding: 'SUB_SEARCH' },
  // Phase 3: outbound customer webhooks (external_webhooks)
  { id: 'webhooks', topics: ['*'], queueBinding: 'SUB_WEBHOOKS' },
  // Phase 4: WeldConnect entity_event triggers
  { id: 'weldconnect', topics: ['*'], queueBinding: 'SUB_WELDCONNECT' },
  // Phase 5+: weldagent / realtime — registry rows land with their queues later
  // so the hub never sends to missing bindings in production.
] as const);

/**
 * Filter the registry to subscribers matching `eventType`.
 */
export function matchEntityEventSubscribers(
  eventType: string,
  subscribers: readonly EntityEventSubscriber[] = ENTITY_EVENT_SUBSCRIBERS,
): EntityEventSubscriber[] {
  return subscribers.filter((sub) => topicMatches(sub.topics, eventType));
}
