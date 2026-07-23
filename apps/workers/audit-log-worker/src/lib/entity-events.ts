/**
 * Re-exports the shared wire-format types from `@weldsuite/entity-events`.
 *
 * The audit-log-worker is a queue consumer, so it only needs the
 * `EntityEventMessage` type. Producers live in `apps/api-worker` and
 * `apps/workers/app-api`; both publish messages of the shape declared in the
 * shared package.
 */

export type {
  EntityAction,
  EventSource,
  EntityEventMessage,
} from '@weldsuite/entity-events/types';
