/**
 * Consumer contract for the entity-event dispatcher.
 *
 * A consumer declares what it subscribes to and receives a **batch slice** —
 * the events from one queue batch, for one workspace, that matched its filter.
 * Batches rather than single events so consumers can coalesce; `search-index`
 * already does that by hand and this makes it the default shape.
 *
 * Runtime-dependency-free except for the tenant-db type alias, so a consumer
 * module costs nothing to import.
 */

import type { EntityEventMessage } from '../types';
import type { TenantDb } from '../internal-types';

/**
 * What a consumer listens for. Colon or dotted form both work; they are
 * normalised on registration.
 *
 *   '*'                  every event
 *   'customer:*'         every action on customers
 *   'ticket:created'     one exact event
 *   'co_*'               any WeldObjects custom object, any action
 *
 * Validated against the events catalog at registration, so a typo'd
 * `custmer:created` throws at module load instead of silently matching nothing.
 */
export type ConsumerSubscription = string;

export interface ConsumerContext<Env = unknown> {
  env: Env;
  /** The workspace every event in this slice belongs to. */
  workspaceId: string;
  /**
   * Tenant database handle, resolved once per workspace per batch and shared
   * across every consumer in that batch. Present only when the consumer sets
   * `needsTenantDb`.
   */
  db?: TenantDb;
}

interface BaseConsumer {
  /**
   * Stable id. Appears in logs, metrics and dead-letter records — renaming one
   * orphans its history, so treat it as permanent.
   */
  name: string;
  /** `'*'` or a list of subscriptions. */
  subscribes: readonly ConsumerSubscription[] | '*';
}

/**
 * Runs inside the dispatcher's isolate. Cheap, but it shares the dispatcher's
 * CPU budget with every other inline consumer — anything heavy or slow belongs
 * on `'queue'` transport instead.
 */
export interface InlineConsumer<Env = unknown> extends BaseConsumer {
  transport?: 'inline';
  /** Resolve the tenant DB before calling `handle`. */
  needsTenantDb?: boolean;
  handle(events: EntityEventMessage[], ctx: ConsumerContext<Env>): Promise<void>;
}

/**
 * Forwards its matched slice to a dedicated queue and returns. Use when the
 * work is heavy enough to need its own isolate, concurrency limit or retry
 * budget — the semantic indexer being the motivating case.
 */
export interface QueueConsumer extends BaseConsumer {
  transport: 'queue';
  /** Name of the `Queue` binding on the dispatcher's env. */
  queueBinding: string;
}

export type EntityEventConsumer<Env = unknown> = InlineConsumer<Env> | QueueConsumer;

export function isQueueConsumer<Env>(
  consumer: EntityEventConsumer<Env>,
): consumer is QueueConsumer {
  return consumer.transport === 'queue';
}
