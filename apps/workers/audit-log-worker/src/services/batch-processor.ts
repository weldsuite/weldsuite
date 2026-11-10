/**
 * What the AUDIT_EVENTS consumer does with a batch: write every event to its
 * tenant database, and decide what each failure means for its message.
 *
 *  - success: ack;
 *  - the tenant database is locked by a move (28P01 / 25006): send the event
 *    back onto the queue with a growing delay (`lockedRetryDelaySeconds`), up
 *    to `LOCKED_MAX_RETRIES` times, about four hours in all. A move holds the
 *    lock from minutes to the better part of an hour, and an event produced
 *    just before it must survive that: this is the one failure that is
 *    expected and temporary. The count travels in the message body
 *    (`auditLockRetries`), so a lock wait never uses up the consumer's
 *    `max_retries`, and a re-sent message starts with a fresh `attempts`;
 *  - anything else, or a lock that outlasts its budget: retry at once, as
 *    before. After the consumer's `max_retries` (wrangler.toml) Cloudflare
 *    moves the message to the dead-letter queue instead of deleting it.
 *
 * After the loop, every workspace that had an audit row written gets one flush
 * of its audit log streams (SIEM push), reusing the tenant database handle the
 * batch already opened. The messages are acked by then, and a flush that fails
 * or throws is logged by kind and otherwise ignored: the streams keep their own
 * cursor and catch up on the next flush, so it never fails or retries a message.
 *
 * Log lines carry the event id and the kind of failure only: the driver's own
 * message can quote SQL with the event's data or a connection string.
 */

import type { Env } from '../env';
import type { EntityEventMessage } from '../lib/entity-events';
import { isTenantLockedError } from '../lib/pg-errors';
import { createTenantDbResolver, processEntityEvent, type TenantDbResolver } from './event-processor';
import { flushStreamsForWorkspace } from './stream-flusher';
import type { Database } from '../db';

/** An entity event as this queue carries it: plus the lock retries it has had. */
export type AuditQueueMessage = EntityEventMessage & { auditLockRetries?: number };

/** First pause before a locked tenant database is tried again; doubles each time. */
export const LOCKED_RETRY_BASE_DELAY_SECONDS = 60;
/** Longest pause between two tries of a locked tenant database. */
export const LOCKED_RETRY_MAX_DELAY_SECONDS = 15 * 60;
/** Lock retries before the event falls back to the normal retry path (~4h of waiting). */
export const LOCKED_MAX_RETRIES = 20;

/** Delay before lock retry number `retry` (1-based): 60 s, 2 min, 4 min, 8 min, then 15 min. */
export function lockedRetryDelaySeconds(retry: number): number {
  return Math.min(LOCKED_RETRY_BASE_DELAY_SECONDS * 2 ** (retry - 1), LOCKED_RETRY_MAX_DELAY_SECONDS);
}

type EventProcessor = (event: EntityEventMessage, env: Env, tenantDb: TenantDbResolver) => Promise<void>;

/** Pushes one workspace's new audit rows to its streams. */
type StreamFlusher = (db: Database, workspaceId: string, env: Env) => Promise<unknown>;

function kindOf(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown error';
}

/** Re-send a locked event with a delay. False when the lock budget is spent or the send failed. */
async function requeueLocked(message: Message<AuditQueueMessage>, env: Env): Promise<boolean> {
  const retry = (message.body.auditLockRetries ?? 0) + 1;
  if (retry > LOCKED_MAX_RETRIES) {
    console.error(`[Queue] Tenant database of event ${message.body.id} still locked after ${LOCKED_MAX_RETRIES} lock retries`);
    return false;
  }
  const delaySeconds = lockedRetryDelaySeconds(retry);
  try {
    await env.AUDIT_EVENTS.send({ ...message.body, auditLockRetries: retry }, { delaySeconds });
  } catch (err) {
    console.error(`[Queue] Could not re-queue locked event ${message.body.id}: ${kindOf(err)}`);
    return false;
  }
  console.warn(
    `[Queue] Tenant database of event ${message.body.id} is locked (a database move?), retrying in ${delaySeconds}s (lock retry ${retry})`,
  );
  message.ack();
  return true;
}

export async function processAuditBatch(
  batch: MessageBatch<AuditQueueMessage>,
  env: Env,
  process: EventProcessor = processEntityEvent,
  flushStreams: StreamFlusher = flushStreamsForWorkspace,
): Promise<void> {
  console.log(`[Queue] Processing batch of ${batch.messages.length} audit events`);

  const tenantDb = createTenantDbResolver(env);
  const written = new Set<string>();

  for (const message of batch.messages) {
    try {
      await process(message.body, env, tenantDb);
      message.ack();
      const workspaceId = message.body.metadata?.workspaceId;
      if (workspaceId) written.add(workspaceId);
    } catch (err) {
      if (isTenantLockedError(err) && (await requeueLocked(message, env))) continue;

      console.error(`[Queue] Failed to process event ${message.body.id}: ${kindOf(err)} (attempt ${message.attempts})`);
      message.retry();
    }
  }

  await flushWorkspaceStreams(written, tenantDb, env, flushStreams);
}

/** One flush per workspace the batch wrote for, in parallel; a failure of one never touches another. */
async function flushWorkspaceStreams(
  workspaceIds: ReadonlySet<string>,
  tenantDb: TenantDbResolver,
  env: Env,
  flushStreams: StreamFlusher,
): Promise<void> {
  await Promise.all(
    [...workspaceIds].map(async (workspaceId) => {
      try {
        await flushStreams(await tenantDb(workspaceId), workspaceId, env);
      } catch (err) {
        console.error(`[Queue] Audit stream flush failed for workspace ${workspaceId}: ${kindOf(err)}`);
      }
    }),
  );
}
