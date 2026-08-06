/**
 * The dispatcher — one queue batch in, every matching consumer out.
 *
 * Shape of a run:
 *   1. group the batch by workspace (one tenant DB serves a whole workspace's
 *      slice, resolved once and shared by every consumer that asked for it)
 *   2. per workspace, hand each consumer only the events matching its filter
 *   3. run those consumers concurrently, isolated from each other
 *   4. ack a message only once every consumer that matched it succeeded
 *
 * Step 4 is why **consumers must be idempotent on `event.id`**. When one
 * consumer of three fails, the message is retried and all three run again. The
 * alternative — a retry queue per consumer — costs N queues and a lot of
 * bookkeeping, and isn't worth it until a consumer proves it cannot be made
 * idempotent.
 */

import type { EntityEventMessage } from '../types';
import type { TenantDb } from '../internal-types';
import { matches } from './match';
import { isQueueConsumer, type EntityEventConsumer } from './types';

export interface DispatchOptions<Env> {
  env: Env;
  /** The registry. Order is irrelevant — consumers run concurrently. */
  consumers: readonly EntityEventConsumer<Env>[];
  /**
   * Resolves a workspace's tenant DB. Required only if some consumer sets
   * `needsTenantDb`; keeping it a callback is what lets this module stay free
   * of Neon and KV specifics, and makes the dispatcher testable without a DB.
   */
  resolveTenantDb?: (env: Env, workspaceId: string) => Promise<TenantDb>;
}

type QueueMessage = Message<EntityEventMessage>;

/** One consumer's slice of one workspace's messages. */
interface Slice<Env> {
  consumer: EntityEventConsumer<Env>;
  messages: QueueMessage[];
}

function groupByWorkspace(messages: readonly QueueMessage[]): Map<string, QueueMessage[]> {
  const byWorkspace = new Map<string, QueueMessage[]>();

  for (const message of messages) {
    const workspaceId = message.body?.metadata?.workspaceId;
    const eventType = message.body?.eventType;

    // Malformed beyond routing. Retrying can never add a workspace id, so ack
    // rather than loop it to the dead-letter queue.
    if (!workspaceId || !eventType) {
      console.error(
        `[entity-events] unroutable message ${message.id} ` +
          `(workspaceId=${workspaceId ?? 'missing'}, eventType=${eventType ?? 'missing'}) — acking`,
      );
      message.ack();
      continue;
    }

    const existing = byWorkspace.get(workspaceId);
    if (existing) existing.push(message);
    else byWorkspace.set(workspaceId, [message]);
  }

  return byWorkspace;
}

function sliceForConsumers<Env>(
  consumers: readonly EntityEventConsumer<Env>[],
  messages: readonly QueueMessage[],
): Slice<Env>[] {
  const slices: Slice<Env>[] = [];

  for (const consumer of consumers) {
    const matched = messages.filter((m) => matches(m.body.eventType, consumer.subscribes));
    if (matched.length > 0) slices.push({ consumer, messages: matched });
  }

  return slices;
}

async function runSlice<Env>(
  slice: Slice<Env>,
  env: Env,
  workspaceId: string,
  db: TenantDb | undefined,
): Promise<void> {
  const { consumer, messages } = slice;
  const events = messages.map((m) => m.body);

  if (isQueueConsumer(consumer)) {
    const queue = (env as Record<string, unknown>)[consumer.queueBinding] as
      | Queue<EntityEventMessage>
      | undefined;
    if (!queue) {
      // A misconfigured binding is not something a retry fixes, but staying
      // loud beats dropping the slice: let it exhaust its retries and land in
      // the dead-letter queue where it can be seen.
      throw new Error(
        `queue binding "${consumer.queueBinding}" is not bound on the dispatcher env`,
      );
    }
    await queue.sendBatch(events.map((body) => ({ body })));
    return;
  }

  // An async wrapper so a synchronous throw inside handle() surfaces as a
  // rejection rather than taking down the whole dispatch.
  await (async () => consumer.handle(events, { env, workspaceId, db }))();
}

export async function dispatch<Env>(
  batch: MessageBatch<EntityEventMessage>,
  opts: DispatchOptions<Env>,
): Promise<void> {
  const { env, consumers, resolveTenantDb } = opts;

  // Phase 1 runs with an empty registry on purpose: shadow traffic, so the
  // volume and shape can be watched before anything depends on it.
  if (consumers.length === 0) {
    console.log(
      `[entity-events] no consumers registered — acking ${batch.messages.length} message(s)`,
    );
    for (const message of batch.messages) message.ack();
    return;
  }

  const byWorkspace = groupByWorkspace(batch.messages);

  for (const [workspaceId, messages] of byWorkspace) {
    const slices = sliceForConsumers(consumers, messages);

    // Nothing subscribes to anything in this slice. Acking is correct, not a
    // silent drop: an event with no consumer has been fully handled.
    if (slices.length === 0) {
      for (const message of messages) message.ack();
      continue;
    }

    let db: TenantDb | undefined;
    const needsDb = slices.some((s) => !isQueueConsumer(s.consumer) && s.consumer.needsTenantDb);

    if (needsDb) {
      if (!resolveTenantDb) {
        throw new Error(
          '[entity-events] a consumer needs a tenant DB but dispatch() was given no resolveTenantDb',
        );
      }
      try {
        db = await resolveTenantDb(env, workspaceId);
      } catch (err) {
        // Retry, unlike the search-index consumer, which acks here. That
        // consumer predates having a dead-letter queue and could only choose
        // between acking and recycling forever. With a DLQ, a deleted
        // workspace's backlog lands somewhere inspectable after max_retries,
        // and a transient Neon fault gets the retries it deserves.
        console.error(
          `[entity-events] cannot resolve workspace ${workspaceId} — retrying ${messages.length} message(s):`,
          err instanceof Error ? err.message : err,
        );
        for (const message of messages) message.retry();
        continue;
      }
    }

    const results = await Promise.allSettled(
      slices.map((slice) => runSlice(slice, env, workspaceId, db)),
    );

    // A message is retried if any consumer that matched it failed.
    const failed = new Set<QueueMessage>();
    results.forEach((result, i) => {
      if (result.status !== 'rejected') return;
      const slice = slices[i]!;
      console.error(
        `[entity-events] consumer "${slice.consumer.name}" failed for workspace ${workspaceId} ` +
          `(${slice.messages.length} message(s)):`,
        result.reason instanceof Error ? result.reason.message : result.reason,
      );
      for (const message of slice.messages) failed.add(message);
    });

    for (const message of messages) {
      if (failed.has(message)) message.retry();
      else message.ack();
    }
  }
}
