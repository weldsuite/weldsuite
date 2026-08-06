/**
 * Consumer runtime for the entity-event dispatcher.
 *
 * Importable without the publisher: a consumer worker needs the contract, the
 * matcher and `dispatch()`, not `publishEntityEvent`.
 */

export {
  isQueueConsumer,
  type ConsumerContext,
  type ConsumerSubscription,
  type EntityEventConsumer,
  type InlineConsumer,
  type QueueConsumer,
} from './types';

export { defineConsumer, validateRegistry } from './registry';

export {
  CUSTOM_OBJECT_WILDCARD,
  WILDCARD,
  matches,
  matchesOne,
  normalizeSubscription,
  splitEventName,
} from './match';

export { dispatch, type DispatchOptions } from './dispatch';
