/**
 * What the AUDIT_EVENTS consumer does with a batch: write every event to its
 * tenant database, and decide what each failure means for its message.
 *
 *  - success: ack;
 *  - the tenant database is locked by a move (28P01 / 25006): retry after
 *    `LOCKED_RETRY_DELAY_SECONDS`, up to the consumer's `max_retries`
 *    (wrangler.toml). A move holds the lock from minutes to the better part of
 *    an hour, and an event produced just before it must survive that: this is
 *    the one failure that is expected and temporary;
 *  - anything else: retry at once, as before, and drop after
 *    `OTHER_MAX_RETRIES` retries (the limit that used to be the consumer's
 *    default). Raising `max_retries` for the lock must not triple the retries
 *    of events that can never succeed (a deleted workspace, a bad payload).
 *
 * Log lines carry the event id and the kind of failure only: the driver's own
 * message can quote SQL with the event's data or a connection string.
 */

import type { Env } from '../env';
import type { EntityEventMessage } from '../lib/entity-events';
import { isTenantLockedError } from '../lib/pg-errors';
import { processEntityEvent } from './event-processor';

/** Pause before a locked tenant database is tried again. */
export const LOCKED_RETRY_DELAY_SECONDS = 120;
/** Retries of any other failure before the message is dropped (the old consumer default). */
export const OTHER_MAX_RETRIES = 3;

type EventProcessor = (event: EntityEventMessage, env: Env) => Promise<void>;

function kindOf(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown error';
}

export async function processAuditBatch(
  batch: MessageBatch<EntityEventMessage>,
  env: Env,
  process: EventProcessor = processEntityEvent,
): Promise<void> {
  console.log(`[Queue] Processing batch of ${batch.messages.length} audit events`);

  for (const message of batch.messages) {
    try {
      await process(message.body, env);
      message.ack();
    } catch (err) {
      if (isTenantLockedError(err)) {
        console.warn(
          `[Queue] Tenant database of event ${message.body.id} is locked (a database move?), retrying in ${LOCKED_RETRY_DELAY_SECONDS}s (attempt ${message.attempts})`,
        );
        message.retry({ delaySeconds: LOCKED_RETRY_DELAY_SECONDS });
        continue;
      }

      console.error(`[Queue] Failed to process event ${message.body.id}: ${kindOf(err)}`);
      if (message.attempts > OTHER_MAX_RETRIES) {
        console.error(`[Queue] Dropping event ${message.body.id} after ${message.attempts} attempts`);
        message.ack();
      } else {
        message.retry();
      }
    }
  }
}
