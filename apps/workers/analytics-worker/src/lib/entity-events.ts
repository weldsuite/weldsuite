/**
 * Re-exports the shared wire-format types from `@weldsuite/entity-events`.
 *
 * The analytics-worker is a queue consumer; the shape comes from the
 * shared package and stays in lockstep with the producers.
 */

export type {
  EntityAction,
  EventSource,
  EntityEventMessage,
} from '@weldsuite/entity-events/types';
