/**
 * `MailboxObject`'s destroy flow (design §3.8, task C1). Destroying a mailbox
 * is staged so no single alarm tick has to both drain an unbounded R2 prefix
 * and finish a cross-object RPC round trip to `MailIndex`:
 *
 *   1. `beginDestroy` flips `meta.destroying` on. Idempotent: calling it again
 *      while a destroy is already in progress just returns the existing
 *      state (design §3.8 point 3, "calling destroy again is a no-op that
 *      keeps going where it stopped").
 *   2. `continueDestroy`, called once per alarm tick (`alarm.ts`), advances
 *      exactly one stage: `'r2'` (delete every object under
 *      `mail/<ws>/<acc>/` via `deleteMailboxObjects`, `../store/bodies`) →
 *      `'ledger'` (tell `MailIndex` to forget this mailbox) → `'done'`. Each
 *      stage is itself idempotent — deleting an already-empty prefix, or
 *      calling `dropMailbox` a second time, are both no-ops — so a crash (or
 *      an isolate eviction) between stages just repeats the last one on the
 *      next alarm.
 *   3. Once `continueDestroy` reports `done`, the caller wipes the object
 *      (`ctx.storage.deleteAll()` + `deleteAlarm()`) — not this file's job,
 *      since that needs the real `DurableObjectState`, not the narrow
 *      `{sql}` surface every function here takes.
 *
 * `deleteMailboxObjects` itself drains every R2 list page inside ONE call (it
 * has no resumable cursor to hand back across invocations), so the "pages
 * across alarm runs" the design and task description ask for happens at the
 * STAGE level here — R2 in one tick, the `MailIndex` call in the next — not
 * at the level of individual R2 list pages within the R2 stage. Giving
 * `deleteMailboxObjects` a cursor-resumable variant would mean editing
 * `store/bodies.ts`, which is outside this task's file set (owned by the
 * worker-side client task running in parallel in this worktree).
 */

import type { MailboxRef } from '../store/types';
import { deleteMailboxObjects } from '../store/bodies';

export const MAILBOX_DESTROYED_CODE = 'MAILBOX_DESTROYED';

/** Thrown by write RPCs once `destroy()` has been accepted for this mailbox. */
export class MailboxDestroyedError extends Error {
  readonly code = MAILBOX_DESTROYED_CODE;

  constructor(ref: Pick<MailboxRef, 'workspaceId' | 'accountId'>) {
    super(`MailboxObject: mailbox ${ref.workspaceId}:${ref.accountId} is being destroyed`);
    this.name = 'MailboxDestroyedError';
  }
}

export type DestroyStage = 'r2' | 'ledger' | 'done';

export interface DestroyState {
  startedAt: number;
  stage: DestroyStage;
  /** R2 objects deleted so far (informational; surfaced via `status()`). */
  deleted: number;
}

/** The subset of `ctx.storage` this file needs. */
export interface DestroyStorage {
  sql: SqlStorage;
}

const META_KEY = 'destroying';

function readMeta(sql: SqlStorage): string | null {
  const row = sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', META_KEY).toArray()[0];
  return row ? row.value : null;
}

function writeMeta(sql: SqlStorage, value: string): void {
  sql.exec(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    META_KEY,
    value,
  );
}

export function getDestroyState(sql: SqlStorage): DestroyState | null {
  const raw = readMeta(sql);
  return raw === null ? null : (JSON.parse(raw) as DestroyState);
}

export function isDestroying(sql: SqlStorage): boolean {
  return getDestroyState(sql) !== null;
}

/** Idempotent: a destroy already in progress is left untouched. */
export function beginDestroy(storage: DestroyStorage, now: number): DestroyState {
  const existing = getDestroyState(storage.sql);
  if (existing) return existing;
  const state: DestroyState = { startedAt: now, stage: 'r2', deleted: 0 };
  writeMeta(storage.sql, JSON.stringify(state));
  return state;
}

export interface ContinueDestroyEnv {
  /** EU-jurisdiction bucket for raw MIME and message bodies (decision 7). */
  MAIL_STORAGE?: R2Bucket;
}

/**
 * Advances the destroy state machine by exactly one stage. The caller
 * (`alarm.ts`) re-schedules itself immediately while `done` is `false`.
 * `dropFromIndex` is the caller's closure over its own `MAIL_INDEX` binding —
 * this file doesn't know `MailIndex`'s shape, matching how `outbox.ts` (not
 * this one) is the one that imports `mail-index/client`.
 *
 * Missing bindings (no `MAIL_STORAGE`, or `dropFromIndex` throwing) are
 * logged as errors and the stage is retried on the next tick rather than
 * silently skipped — losing track of undeleted R2 objects or an un-forgotten
 * mailbox in the ledger would otherwise never surface.
 */
export async function continueDestroy(
  storage: DestroyStorage,
  env: ContinueDestroyEnv,
  ref: Pick<MailboxRef, 'workspaceId' | 'accountId'>,
  dropFromIndex: () => Promise<void>,
): Promise<{ done: boolean; state: DestroyState }> {
  const state = getDestroyState(storage.sql) ?? beginDestroy(storage, Date.now());

  if (state.stage === 'r2') {
    if (!env.MAIL_STORAGE) {
      console.error('[mailbox-store] destroy: no MAIL_STORAGE binding, will retry:', `${ref.workspaceId}:${ref.accountId}`);
      return { done: false, state };
    }
    try {
      const { deleted } = await deleteMailboxObjects(env.MAIL_STORAGE, ref);
      state.deleted += deleted;
      state.stage = 'ledger';
      writeMeta(storage.sql, JSON.stringify(state));
    } catch (err) {
      console.error('[mailbox-store] destroy: R2 cleanup failed, will retry:', err instanceof Error ? err.message : err);
    }
    return { done: false, state };
  }

  if (state.stage === 'ledger') {
    try {
      await dropFromIndex();
      state.stage = 'done';
      writeMeta(storage.sql, JSON.stringify(state));
    } catch (err) {
      console.error('[mailbox-store] destroy: MailIndex.dropMailbox failed, will retry:', err instanceof Error ? err.message : err);
    }
    return { done: false, state };
  }

  return { done: true, state };
}
