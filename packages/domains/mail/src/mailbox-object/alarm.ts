/**
 * `MailboxObject`'s single alarm (design §3.6, task C1): multiplexes destroy
 * continuation, snoozed-mail wake-up, outbox delivery (`./outbox`), and a
 * generic "continuation" hook for write ops whose work doesn't fit in one RPC
 * call — `folder.read` (design §3.2: "mark a huge folder read in bounded,
 * resumable batches") and, since task C4, `maintenance` (backfill/catch-up —
 * the actual state machine lives in `./backfill`, keyed off `meta.backfill`;
 * this file only knows "keep calling `tickBackfill` until it says stop").
 * `ContinuationKind` is a plain string union so a future kind only needs a
 * case in `runContinuation`, not a new dispatch mechanism; `runAlarm` itself
 * only grew an `await` and an `env` parameter to support `maintenance`'s
 * tenant-Postgres reads.
 *
 * Order in `runAlarm` matters: destroy is exclusive (design §3.6 calls this
 * out explicitly) — while a mailbox is being torn down, nothing else in that
 * tick touches its data, since snoozes/outbox/continuations all concern data
 * `destroy` may be in the middle of deleting. Snooze wake runs before the
 * outbox drain only because it was written first here; the two are
 * independent (snoozing never adds outbox rows).
 *
 * `recomputeAlarm` is the ONLY place that calls `ctx.storage.setAlarm`/
 * `deleteAlarm` — both from write RPCs (`mailbox-object.ts`'s `apply`/
 * `applyBatch`/`destroy`/`setMode`) and from the end of `runAlarm` itself —
 * so there is one source of truth for "when does this object next wake up".
 * It only ever moves the alarm EARLIER than whatever time is currently
 * scheduled (or sets one where none exists); a call that wants a faster
 * wake-up must never cancel a nearer one a previous call already needs, and a
 * call that finds nothing pending clears the alarm entirely.
 */

import { mailIndexFor, type MailIndexBindingEnv } from '../mail-index/client';
import { parseMailStoreMode } from '../store/mode';
import type { MailboxOp, MailboxRef, MailStoreMode } from '../store/types';
import { getBackfillState, tickBackfill, type BackfillEnv } from './backfill';
import { continueDestroy, getDestroyState, type ContinueDestroyEnv } from './destroy';
import { drainOutbox, type OutboxEnv } from './outbox';
import { applyMailboxOp, type WritableStorage } from './writes';

export type AlarmEnv = OutboxEnv & ContinueDestroyEnv & BackfillEnv;

// ---------------------------------------------------------------------------
// meta helpers (local to this file, matching migrate.ts / mail-index.ts's style)
// ---------------------------------------------------------------------------

function getMeta(sql: SqlStorage, key: string): string | null {
  const row = sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key).toArray()[0];
  return row ? row.value : null;
}

function setMeta(sql: SqlStorage, key: string, value: string): void {
  sql.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

function deleteMeta(sql: SqlStorage, key: string): void {
  sql.exec('DELETE FROM meta WHERE key = ?', key);
}

// ---------------------------------------------------------------------------
// mode (set by the router/backfill — task C3 — never read from Flagship here)
// ---------------------------------------------------------------------------

const MODE_KEY = 'mail_store_mode';

export function getStoredMode(sql: SqlStorage): MailStoreMode {
  const raw = getMeta(sql, MODE_KEY);
  return raw === null ? 'postgres' : parseMailStoreMode(raw);
}

/**
 * Stores `mode` and returns whatever mode was stored before this call (the
 * same default-to-`'postgres'` reading `getStoredMode` would have returned),
 * so a caller — `mailbox-object.ts`'s `setMode` RPC, in turn the router
 * (task C3) — can tell whether this call just told the object about a
 * downgrade without a second round trip.
 */
export function setStoredMode(sql: SqlStorage, mode: MailStoreMode): MailStoreMode {
  const previous = getStoredMode(sql);
  setMeta(sql, MODE_KEY, mode);
  return previous;
}

// ---------------------------------------------------------------------------
// generic continuation (design §3.6 item (c))
// ---------------------------------------------------------------------------

const CONTINUATION_KEY = 'continuation';
/** Keeps a wedged continuation (an op that keeps reporting `more`) from looping forever. */
const MAX_CONTINUATION_ATTEMPTS = 100;

export type ContinuationKind = 'folder.read' | 'maintenance';

/**
 * `'folder.read'` carries the op it keeps re-applying. `'maintenance'`
 * carries nothing of its own — it just means "keep calling `tickBackfill`
 * until `meta.backfill` says otherwise" (task C4); the backfill state machine
 * itself lives in `./backfill`'s `meta.backfill` key, not here.
 */
export type ContinuationState =
  | { kind: 'folder.read'; op: MailboxOp; attempts: number }
  | { kind: 'maintenance'; attempts: number };

function getContinuation(sql: SqlStorage): ContinuationState | null {
  const raw = getMeta(sql, CONTINUATION_KEY);
  return raw === null ? null : (JSON.parse(raw) as ContinuationState);
}

function setContinuation(sql: SqlStorage, state: ContinuationState): void {
  setMeta(sql, CONTINUATION_KEY, JSON.stringify(state));
}

function clearContinuation(sql: SqlStorage): void {
  deleteMeta(sql, CONTINUATION_KEY);
}

/**
 * Registers a `folder.read` continuation — called right after `apply`/
 * `applyBatch` whenever that op's `OpResult.more` comes back `true` (design's
 * "folder.read on a huge folder" risk). Re-applying the SAME op is safe
 * because `folder.read` re-queries the live unread set on every call (no
 * cursor to go stale, `writes-extra.ts`'s `applyFolderRead`); a later
 * continuation kind just needs its own op-shaped payload and a case in
 * `runContinuation`.
 */
export function registerContinuation(sql: SqlStorage, op: MailboxOp): void {
  setContinuation(sql, { kind: 'folder.read', op, attempts: 0 });
}

/**
 * Registers the backfill/catch-up continuation (task C4) — called by
 * `mailbox-object.ts`'s `startBackfill`/`rebuildMailbox` RPCs right after
 * `./backfill`'s own state write. Idempotent: calling it while one is already
 * registered just resets `attempts`, which only affects the unrecognised-kind
 * giving-up counter below, not `./backfill`'s own attempt/backoff tracking.
 */
export function registerMaintenanceContinuation(sql: SqlStorage): void {
  setContinuation(sql, { kind: 'maintenance', attempts: 0 });
}

/**
 * One continuation step. Returns `true` if it did work (whether or not it
 * finished). Async because the `'maintenance'` kind's `tickBackfill` reads
 * tenant Postgres; `'folder.read'` stays a synchronous SQL-only op underneath.
 */
async function runContinuation(storage: WritableStorage, env: AlarmEnv, ref: MailboxRef, now: number): Promise<boolean> {
  const continuation = getContinuation(storage.sql);
  if (!continuation) return false;

  if (continuation.kind === 'maintenance') {
    await tickBackfill(storage, env, ref, now);
    const state = getBackfillState(storage.sql);
    if (state.state === 'running' || state.state === 'catchup') {
      setContinuation(storage.sql, { kind: 'maintenance', attempts: 0 });
    } else {
      clearContinuation(storage.sql);
    }
    return true;
  }

  if (continuation.kind !== 'folder.read') {
    console.error('[mailbox-store] alarm: unrecognised continuation kind, dropping it:', JSON.stringify(continuation));
    clearContinuation(storage.sql);
    return true;
  }

  const result = applyMailboxOp(storage, ref, continuation.op, now);
  if (result.more) {
    const attempts = continuation.attempts + 1;
    if (attempts >= MAX_CONTINUATION_ATTEMPTS) {
      console.error('[mailbox-store] alarm: folder.read continuation exceeded max attempts, giving up:', `${ref.workspaceId}:${ref.accountId} attempts=${attempts}`);
      clearContinuation(storage.sql);
      return true;
    }
    setContinuation(storage.sql, { ...continuation, attempts });
  } else {
    clearContinuation(storage.sql);
  }
  return true;
}

// ---------------------------------------------------------------------------
// snooze wake (design §3.6 item (b); task notes: acts in `object` AND
// `object-only` — the object is actually READ in both of those modes, so
// both need a backstop wake for whenever nothing happens to be reading the
// mailbox right when a snooze comes due (`mailbox-object.ts`'s
// `wakeOverdueSnoozes` now covers the "someone IS reading" case on every
// `listThreads`/`stats`/`labelCounts`/`unreadCount` call). `postgres` and
// `shadow` skip this entirely — in `shadow` the object is never read at all
// (design: "in shadow the object is not read, so leave it"), and
// `cron/snooze-sweep.ts` against Postgres is the authoritative wake for both
// of those modes; this object doesn't even bother computing a snoozed-due
// alarm candidate for them — see `candidateAlarmTimes` below).
// ---------------------------------------------------------------------------

function nextSnoozeDueAt(sql: SqlStorage): number | null {
  const row = sql
    .exec<{ next: number | null }>(
      `SELECT MIN(snoozed_until) AS next FROM messages WHERE deleted_at IS NULL AND snoozed_until IS NOT NULL`,
    )
    .toArray()[0];
  return row?.next ?? null;
}

/** `true` for the two modes the object is actually read under (`wakeOverdueSnoozes`'s doc above). */
function objectWakesSnoozes(mode: MailStoreMode): boolean {
  return mode === 'object' || mode === 'object-only';
}

function runSnoozeWake(storage: WritableStorage, ref: MailboxRef, now: number): void {
  if (!objectWakesSnoozes(getStoredMode(storage.sql))) return;
  const due = nextSnoozeDueAt(storage.sql);
  if (due === null || due > now) return;
  applyMailboxOp(storage, ref, { kind: 'snooze.wake', now }, now);
}

// ---------------------------------------------------------------------------
// next-alarm computation
// ---------------------------------------------------------------------------

/** design §3.6: "After any write that adds outbox rows, the alarm is set to now + 1s" — batches a burst of writes in the same second onto one tick. */
export const OUTBOX_BATCH_DELAY_MS = 1_000;

function candidateAlarmTimes(sql: SqlStorage, now: number): number[] {
  const candidates: number[] = [];

  // Never-attempted outbox rows batch by OUTBOX_BATCH_DELAY_MS from their
  // creation time, not from their own `next_attempt_at` (which is stamped at
  // write time, i.e. "now") — otherwise every single ingest would wake the
  // object immediately instead of sharing one tick with the rest of its
  // second.
  const fresh = sql.exec<{ next: number | null }>(`SELECT MIN(created_at) AS next FROM outbox WHERE attempts = 0`).toArray()[0];
  if (fresh?.next != null) candidates.push(fresh.next + OUTBOX_BATCH_DELAY_MS);

  // A row that already failed once keeps its own backoff-computed time.
  const retried = sql.exec<{ next: number | null }>(`SELECT MIN(next_attempt_at) AS next FROM outbox WHERE attempts > 0`).toArray()[0];
  if (retried?.next != null) candidates.push(retried.next);

  // `notePgDrift` (`mailbox-object.ts`) now writes `pg_drift`, but nothing
  // drains it yet — the alarm-side mirror-to-Postgres job is still task C4's
  // job (design §3.6 item 4). Reading it here already costs nothing and means
  // this function doesn't need to change once that job lands.
  const drift = sql.exec<{ next: number | null }>(`SELECT MIN(next_attempt_at) AS next FROM pg_drift`).toArray()[0];
  if (drift?.next != null) candidates.push(drift.next);

  const continuation = getContinuation(sql);
  if (continuation?.kind === 'maintenance') {
    // Backfill/catch-up sets its own `nextAttemptAt` on a failed tick (design
    // §4's 1/5/30 min backoff); honour it instead of busy-waking every tick.
    const backfill = getBackfillState(sql);
    if (backfill.state === 'running' || backfill.state === 'catchup') {
      candidates.push(backfill.nextAttemptAt && backfill.nextAttemptAt > now ? backfill.nextAttemptAt : now);
    }
  } else if (continuation) {
    candidates.push(now);
  }
  if (getDestroyState(sql)) candidates.push(now);

  if (objectWakesSnoozes(getStoredMode(sql))) {
    const snoozeNext = nextSnoozeDueAt(sql);
    if (snoozeNext !== null) candidates.push(snoozeNext);
  }

  return candidates;
}

/**
 * Only ever moves the alarm EARLIER (or sets one where none exists) — see
 * the file comment. Clears the alarm when nothing at all is pending.
 */
export async function recomputeAlarm(ctx: Pick<DurableObjectState, 'storage'>, now: number = Date.now()): Promise<void> {
  const candidates = candidateAlarmTimes(ctx.storage.sql, now);
  if (candidates.length === 0) {
    await ctx.storage.deleteAlarm();
    return;
  }
  const earliest = Math.min(...candidates);
  const current = await ctx.storage.getAlarm();
  if (current === null || earliest < current) {
    await ctx.storage.setAlarm(earliest);
  }
}

/**
 * Called by `mailbox-object.ts`'s `apply`/`applyBatch` right after a
 * successful write: registers a `folder.read` continuation immediately when
 * `more` came back `true`, then recomputes the alarm (which independently
 * discovers any new outbox rows from the table itself — see
 * `candidateAlarmTimes` — so ingest's batching delay doesn't need to be
 * special-cased here).
 */
export async function afterWrite(
  ctx: Pick<DurableObjectState, 'storage'>,
  op: MailboxOp,
  result: { more?: boolean },
): Promise<void> {
  if (op.kind === 'folder.read' && result.more) {
    registerContinuation(ctx.storage.sql, op);
  }
  await recomputeAlarm(ctx);
}

// ---------------------------------------------------------------------------
// alarm() itself
// ---------------------------------------------------------------------------

/**
 * The object's one `alarm()` handler (design §3.6). `ref` is reconstructed by
 * the class from its own bound meta (`workspace_id`/`account_id`/
 * `clerk_org_id`) since a real Durable Object alarm takes no arguments.
 */
export async function runAlarm(ctx: DurableObjectState, env: AlarmEnv & MailIndexBindingEnv, ref: MailboxRef): Promise<void> {
  const sql = ctx.storage.sql;
  const storage: WritableStorage = ctx.storage;

  if (getDestroyState(sql)) {
    const { done } = await continueDestroy(ctx.storage, env, ref, async () => {
      const stub = mailIndexFor(env, ref.workspaceId);
      if (!stub) {
        console.warn('[mailbox-store] destroy: no MAIL_INDEX binding, skipping dropMailbox for:', `${ref.workspaceId}:${ref.accountId}`);
        return;
      }
      await stub.dropMailbox(ref.workspaceId, ref.accountId);
    });
    if (done) {
      await ctx.storage.deleteAlarm();
      await ctx.storage.deleteAll();
      return;
    }
    await recomputeAlarm(ctx);
    return;
  }

  const now = Date.now();
  runSnoozeWake(storage, ref, now);
  await drainOutbox(sql, env, ref, now);
  await runContinuation(storage, env, ref, now);

  await recomputeAlarm(ctx, now);
}
