/**
 * `MailboxObject`'s outbox drain (design §3.6 step 3, task C1): delivers rows
 * the write core queued (`writes.ts`'s `insertIngestOutboxRows`, the only
 * writer today) — one `ledger.mail` row (participant addresses, for
 * `MailIndex`) and one `entity_event` row (the same shape
 * `publishEntityEvent` would send, so workflows/agents/realtime/audit/
 * webhooks stay wired through the usual hub queue) per ingested message.
 * `alarm.ts` calls `drainOutbox` once per tick; this file never schedules
 * anything itself — recomputing the next alarm is `alarm.ts`'s job, so there
 * is exactly one place deciding the object's next wake-up time.
 *
 * Both row kinds retry with the same exponential backoff
 * (`min(5s * 2^attempts, 1h)`). A row that has failed `MAX_OUTBOX_ATTEMPTS`
 * times stays in the table — never silently dropped — with its last error
 * recorded and backed off at the 1h ceiling, logged once more as an error
 * (design §3.6: "after 20 attempts the row stays and an error is logged").
 * Only a row of an unrecognised `kind` (a bug in some future writer; neither
 * of today's two kinds ever produces this) is dropped outright, since there
 * is no handler that could ever deliver it.
 */

import { publishEntityEventRaw, type EntityAction, type EntityEventPublisherEnv } from '@weldsuite/entity-events';
import type { EntityType } from '@weldsuite/entity-events/events';
import { mailIndexFor, type MailIndexBindingEnv } from '../mail-index/client';
import type { MailAddressBatchEntry } from '../mail-index/types';
import type { MailboxRef } from '../store/types';

export interface OutboxEnv extends EntityEventPublisherEnv, MailIndexBindingEnv {}

// `type`, not `interface`: `SqlStorage.exec<T extends Record<string, SqlStorageValue>>`
// only accepts a `type` alias here (see `./sql.ts`'s `MessageRow` comment for
// why — an `interface` with identical members fails the same constraint).
export type OutboxRow = {
  seq: number;
  kind: string;
  payload: string;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
};

interface EntityEventOutboxPayload {
  entityType: string;
  action: string;
  entityId: string;
  data: Record<string, unknown>;
}

export interface DrainOutboxResult {
  delivered: number;
  failed: number;
  /** Rows still in the table after this drain (due now or backed off into the future). */
  remaining: number;
}

/** One alarm tick's worth of `ledger.mail` rows (design §3.6: "up to 500 … go to the ledger as one `recordMailAddresses` call"). */
const LEDGER_BATCH_LIMIT = 500;
/** After this many failed attempts a row stays in place (never dropped) at the backoff ceiling, logged as an error each time. */
const MAX_OUTBOX_ATTEMPTS = 20;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CEILING_MS = 60 * 60_000;

function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_CEILING_MS);
}

function markFailed(sql: SqlStorage, row: OutboxRow, now: number, message: string): void {
  const attempts = row.attempts + 1;
  if (attempts >= MAX_OUTBOX_ATTEMPTS) {
    console.error('[mailbox-store] outbox row exceeded max attempts, leaving it in place:', `seq=${row.seq} kind=${row.kind} attempts=${attempts}: ${message}`);
  }
  sql.exec(
    'UPDATE outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE seq = ?',
    attempts,
    now + backoffMs(attempts),
    message,
    row.seq,
  );
}

function deleteRow(sql: SqlStorage, seq: number): void {
  sql.exec('DELETE FROM outbox WHERE seq = ?', seq);
}

async function drainLedgerRows(
  sql: SqlStorage,
  env: OutboxEnv,
  ref: Pick<MailboxRef, 'workspaceId'>,
  rows: OutboxRow[],
  now: number,
): Promise<{ delivered: number; failed: number }> {
  if (rows.length === 0) return { delivered: 0, failed: 0 };
  const stub = mailIndexFor(env, ref.workspaceId);
  if (!stub) {
    console.warn('[mailbox-store] outbox: no MAIL_INDEX binding, deferring ledger.mail rows for workspace:', ref.workspaceId);
    for (const row of rows) markFailed(sql, row, now, 'MAIL_INDEX binding not configured');
    return { delivered: 0, failed: rows.length };
  }
  try {
    const entries = rows.map((row) => JSON.parse(row.payload) as MailAddressBatchEntry);
    await stub.recordMailAddresses(ref.workspaceId, entries);
    for (const row of rows) deleteRow(sql, row.seq);
    return { delivered: rows.length, failed: 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    for (const row of rows) markFailed(sql, row, now, message);
    return { delivered: 0, failed: rows.length };
  }
}

/**
 * `publishEntityEventRaw` never rejects: `@weldsuite/entity-events`'s own
 * `enqueueHubEntityEvent` catches a failed `ENTITY_EVENTS.send()` internally
 * (logs it, resolves anyway) and a missing binding is a no-op warning, not an
 * error — the same fire-and-forget contract `publishEntityEvent` gives every
 * Hono route. So this function's `catch` only ever fires for a malformed
 * stored payload (`JSON.parse`); an actual queue-send failure is retried by
 * Cloudflare Queues itself (the hub queue's own `max_retries`/DLQ), not by
 * this row staying in the outbox table.
 */
async function drainEntityEventRow(
  sql: SqlStorage,
  env: OutboxEnv,
  ref: Pick<MailboxRef, 'workspaceId' | 'clerkOrgId'>,
  row: OutboxRow,
  now: number,
): Promise<boolean> {
  try {
    const payload = JSON.parse(row.payload) as EntityEventOutboxPayload;
    await publishEntityEventRaw({
      env,
      // Entity events key on the Clerk org id until their consumers move to
      // `workspaces.id` (see @weldsuite/entity-events's publisher.ts) — the
      // same choice `publishEntityEvent` makes from a Hono context.
      workspaceId: ref.clerkOrgId ?? ref.workspaceId,
      userId: 'system',
      entityType: payload.entityType as EntityType,
      action: payload.action as EntityAction,
      entityId: payload.entityId,
      data: payload.data,
      source: 'system',
    });
    deleteRow(sql, row.seq);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    markFailed(sql, row, now, message);
    return false;
  }
}

/**
 * Drains every outbox row due at `now`, up to one alarm tick's worth of work
 * (`LEDGER_BATCH_LIMIT` rows). `ledger.mail` rows are delivered as one
 * batched `recordMailAddresses` call (so one flaky write doesn't force a
 * retry of the other 499 for no reason); `entity_event` rows are delivered
 * one at a time (one hub-queue send per row, so a single failure doesn't
 * block the rest).
 */
export async function drainOutbox(
  sql: SqlStorage,
  env: OutboxEnv,
  ref: Pick<MailboxRef, 'workspaceId' | 'clerkOrgId'>,
  now: number,
): Promise<DrainOutboxResult> {
  const due = sql
    .exec<OutboxRow>('SELECT * FROM outbox WHERE next_attempt_at <= ? ORDER BY seq LIMIT ?', now, LEDGER_BATCH_LIMIT)
    .toArray();

  let delivered = 0;
  let failed = 0;

  const ledgerRows = due.filter((r) => r.kind === 'ledger.mail');
  const eventRows = due.filter((r) => r.kind === 'entity_event');
  const unknownRows = due.filter((r) => r.kind !== 'ledger.mail' && r.kind !== 'entity_event');

  const ledgerResult = await drainLedgerRows(sql, env, ref, ledgerRows, now);
  delivered += ledgerResult.delivered;
  failed += ledgerResult.failed;

  for (const row of eventRows) {
    // Sequential on purpose: each send is an independent hub enqueue, and
    // there is no benefit to racing them against this same row set's own
    // backoff bookkeeping.
    // eslint-disable-next-line no-await-in-loop
    const ok = await drainEntityEventRow(sql, env, ref, row, now);
    if (ok) delivered++;
    else failed++;
  }

  for (const row of unknownRows) {
    console.error('[mailbox-store] outbox: dropping row of unrecognised kind:', `seq=${row.seq} kind=${row.kind}`);
    deleteRow(sql, row.seq);
  }

  const remainingRow = sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM outbox').toArray()[0];
  return { delivered, failed, remaining: remainingRow?.n ?? 0 };
}
