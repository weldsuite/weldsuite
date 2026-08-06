/**
 * Consumer registration.
 *
 * `defineConsumer` validates a consumer's subscriptions against the events
 * catalog at module load. A typo'd `custmer:created` throws on import rather
 * than quietly matching nothing for a year — which is the failure mode the old
 * hardcoded fan-out had no way to catch at all.
 */

import { isKnownEntityType, isKnownAction, type EntityType } from '../events';
import { CUSTOM_OBJECT_ENTITY_KEY_PREFIX } from '../custom-objects';
import {
  CUSTOM_OBJECT_WILDCARD,
  WILDCARD,
  normalizeSubscription,
  splitEventName,
} from './match';
import type { EntityEventConsumer } from './types';

function assertValidSubscription(consumerName: string, subscription: string): void {
  const fail = (why: string): never => {
    throw new Error(
      `[entity-events] consumer "${consumerName}" has an invalid subscription ` +
        `"${subscription}": ${why}`,
    );
  };

  if (subscription === WILDCARD || subscription === CUSTOM_OBJECT_WILDCARD) return;

  const parts = splitEventName(subscription);
  if (!parts) {
    return fail(`expected "entityType:action", "entityType:*", "*" or "${CUSTOM_OBJECT_WILDCARD}"`);
  }

  const { entityType, action } = parts;

  // `*:deleted` — one action across every entity type. There is no single
  // catalog entry to validate the action against, so accept any non-wildcard
  // action here; a typo costs a filter that matches nothing rather than a
  // crash, which is the same trade the `*` subscription already makes.
  if (entityType === WILDCARD) {
    if (action === WILDCARD) {
      return fail(`use "${WILDCARD}" rather than "${WILDCARD}:${WILDCARD}"`);
    }
    return;
  }

  // WeldObjects entity types are defined by workspace admins at runtime, so
  // there is no catalog entry to check them against. Accept the prefix and let
  // the tenant's own custom_objects rows be the authority.
  if (entityType.startsWith(CUSTOM_OBJECT_ENTITY_KEY_PREFIX)) return;

  if (!isKnownEntityType(entityType)) {
    return fail(`"${entityType}" is not in the events catalog`);
  }
  if (action === WILDCARD) return;
  if (!isKnownAction(entityType as EntityType, action)) {
    return fail(`"${entityType}" has no action "${action}" in the events catalog`);
  }
}

/**
 * Validate a consumer and return it with its subscriptions normalised.
 * Call at module scope so a bad subscription fails the deploy, not a request.
 */
export function defineConsumer<Env>(consumer: EntityEventConsumer<Env>): EntityEventConsumer<Env> {
  if (!consumer.name.trim()) {
    throw new Error('[entity-events] consumer name must not be empty');
  }

  if (consumer.transport === 'queue') {
    if (!consumer.queueBinding?.trim()) {
      throw new Error(
        `[entity-events] consumer "${consumer.name}" uses transport "queue" ` +
          'but declares no queueBinding',
      );
    }
  } else if (typeof consumer.handle !== 'function') {
    throw new Error(`[entity-events] consumer "${consumer.name}" has no handle()`);
  }

  if (consumer.subscribes === WILDCARD) return consumer;

  if (!Array.isArray(consumer.subscribes) || consumer.subscribes.length === 0) {
    throw new Error(
      `[entity-events] consumer "${consumer.name}" must subscribe to at least one event ` +
        `(use "${WILDCARD}" for all)`,
    );
  }

  for (const subscription of consumer.subscribes) {
    assertValidSubscription(consumer.name, subscription);
  }

  return {
    ...consumer,
    subscribes: consumer.subscribes.map(normalizeSubscription),
  } as EntityEventConsumer<Env>;
}

/**
 * Guard the registry as a whole. Names key logs, metrics and dead-letter
 * records, so a duplicate would silently merge two consumers' histories.
 */
export function validateRegistry<Env>(consumers: readonly EntityEventConsumer<Env>[]): void {
  const seen = new Set<string>();
  for (const consumer of consumers) {
    if (seen.has(consumer.name)) {
      throw new Error(`[entity-events] duplicate consumer name "${consumer.name}"`);
    }
    seen.add(consumer.name);
  }
}
