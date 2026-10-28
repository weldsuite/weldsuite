/**
 * `MailboxStoreObject`: one SQLite Durable Object per mailbox
 * (`mbx:<workspaces.id>:<accountId>`, always reached through
 * `env.MAILBOX_STORE.jurisdiction('eu')` — design decision 1/ADR MAIL-009),
 * built on this package's already-landed pieces: schema/migrations
 * (`./schema`, `./migrate`), the write core (`./writes`, `./writes-extra`)
 * and reads (`./reads`). This file is the thin RPC wrapper the design (§3.5)
 * and the worktree's task notes describe: every public method takes `ref`
 * first, binds the object to it on first call (`bindRef`, mirroring
 * `MailIndex.ensureWorkspace`), and forwards to the plain functions those
 * other files already export against `this.ctx.storage.sql` (or the full
 * `this.ctx.storage` for writes, which need `transactionSync`).
 *
 * `MailboxStoreRpc` mirrors `MailboxStore` (`../store/types`) by hand — every
 * read/write method, ref-first, minus the `ref`/`backend` properties the
 * design says the object doesn't need (it knows its own ref from its name) —
 * plus the admin surface this task adds: `status`, `destroy`, and `setMode`
 * (the mode hint `alarm.ts`'s snooze-wake gate reads; the object never
 * evaluates Flagship itself — see that file's header comment). `implements
 * MailboxStoreRpc` keeps the CLASS and this interface honest (a typo'd or
 * missing method fails to compile); it is not type-level linked back to
 * `MailboxStore` itself, so a future change there still needs a matching
 * edit here — `mailbox-object.test.ts`'s read round-trip tests (every method
 * called through the RPC class compared against calling `reads.ts` directly)
 * are the behavioural backstop for that gap.
 *
 * Scheduling (when the alarm next fires) is entirely `./alarm`'s job —
 * `afterWrite`/`recomputeAlarm` after every write, `runAlarm` for the
 * `alarm()` handler itself. This file never calls `ctx.storage.setAlarm`/
 * `deleteAlarm` directly outside of the destroy hand-off in `alarm()`.
 */

import { DurableObject } from 'cloudflare:workers';
import type {
  FolderKey,
  InboundThreadQuery,
  LabelCount,
  MailAttachmentRecord,
  MailboxOp,
  MailboxRef,
  MailboxStats,
  MailMessageListRow,
  MailMessageRecord,
  MailStoreMode,
  MessageListQuery,
  MessagePage,
  OpResult,
  SnoozedMessage,
  ThreadListQuery,
  ThreadPage,
} from '../store/types';
import type { MailDraft } from '@weldsuite/db/schema/mail-drafts';
import type { MailSubscription } from '@weldsuite/db/schema/mail-subscriptions';
import type { MailEmailAddress } from '@weldsuite/db/schema/mail-messages';
import { getSchemaVersion, migrateMailbox } from './migrate';
import * as reads from './reads';
import { applyMailboxBatch, applyMailboxOp, type WritableStorage } from './writes';
import { nextSnoozeDueAt } from './writes-extra';
import { afterWrite, getStoredMode, recomputeAlarm, registerMaintenanceContinuation, runAlarm, setStoredMode, type AlarmEnv } from './alarm';
import { backfillStatus, rebuildMailbox, startBackfill, type BackfillEnv, type BackfillState, type StartBackfillOptions } from './backfill';
import { beginDestroy, isDestroying, MailboxDestroyedError, type ContinueDestroyEnv } from './destroy';
import { runParity, type ParityReport, type RunParityOptions } from './parity';
import { runReverseSync, type ReverseSyncOptions, type ReverseSyncReport } from './reverse-sync';
import type { OutboxEnv } from './outbox';

export interface MailboxStoreObjectEnv extends OutboxEnv, ContinueDestroyEnv, BackfillEnv {}

export interface MailboxStoreStatusCounts {
  messages: number;
  threads: number;
  attachments: number;
  drafts: number;
  subscriptions: number;
  outboxPending: number;
  /** Rows `notePgDrift` has recorded that the alarm hasn't yet mirrored to Postgres (design §2.2 "object (Postgres failed): ... stub.notePgDrift(ids)"; the mirror job itself is still future work — see `notePgDrift`'s own doc). Reverse sync and parity can read this count (via `status()`) to see how much `object`-mode Postgres drift is outstanding for this mailbox. */
  pgDriftPending: number;
}

export interface MailboxStoreStatus {
  schemaVersion: number;
  workspaceId: string | null;
  accountId: string | null;
  clerkOrgId: string | null;
  mode: MailStoreMode;
  counts: MailboxStoreStatusCounts;
  databaseSize: number;
  sqliteVersion: string;
  /** design §3.7: set once `databaseSize` has crossed 6 GB; sticky (no auto-reset). */
  sizeWarning: boolean;
  /** design §3.7: set once `databaseSize` has crossed 8 GB; sticky (no auto-reset). */
  sizeCritical: boolean;
  /**
   * Placeholder (design §3.7's `searchTrimmed`): this task does not implement
   * the FTS-row trim job the 8 GB threshold calls for, only the
   * warn/flag logging — see the file-level comment on `checkSize`.
   */
  searchTrimmed: boolean;
  destroying: boolean;
  /** Backfill-readiness placeholder: `true` until task C4 lands `meta.backfill` tracking — see `isReady`. */
  ready: boolean;
}

// ---------------------------------------------------------------------------
// The RPC contract: `MailboxStore` (../store/types), ref-first, minus
// `ref`/`backend`, plus the admin surface. Exported so the worker-side client
// (`store/object/*`, built in parallel in this worktree) can type
// `DurableObjectStub<MailboxStoreObject>` against the class directly, or
// import just this interface where it only needs the method shapes.
// ---------------------------------------------------------------------------

export interface MailboxStoreRpc {
  // reads
  listThreads(ref: MailboxRef, q: ThreadListQuery): Promise<ThreadPage>;
  getThread(ref: MailboxRef, threadKey: string): Promise<{ threadId: string; accountId: string; messages: MailMessageRecord[] } | null>;
  getThreadOfMessage(ref: MailboxRef, messageId: string): Promise<{ threadId: string; messages: MailMessageRecord[] } | null>;
  getMessage(
    ref: MailboxRef,
    id: string,
    o?: { bodies?: boolean; attachments?: boolean },
  ): Promise<(MailMessageRecord & { attachments?: MailAttachmentRecord[] }) | null>;
  getMessages(ref: MailboxRef, ids: string[]): Promise<MailMessageListRow[]>;
  listMessages(ref: MailboxRef, q: MessageListQuery): Promise<MessagePage>;
  stats(ref: MailboxRef): Promise<MailboxStats>;
  unreadCount(ref: MailboxRef, scope: 'inbox' | 'all-live'): Promise<number>;
  labelCounts(ref: MailboxRef, keys: FolderKey[]): Promise<Record<FolderKey, LabelCount>>;
  listAttachments(ref: MailboxRef, messageId: string): Promise<MailAttachmentRecord[]>;
  getAttachment(ref: MailboxRef, id: string): Promise<(MailAttachmentRecord & { accountId: string }) | null>;
  recentAttachments(
    ref: MailboxRef,
    q: { before?: { createdAt: number; id: string }; limit: number },
  ): Promise<{ data: MailAttachmentRecord[]; totalCount: number }>;
  recentAddresses(ref: MailboxRef, limit: number): Promise<string[]>;
  resolveInbound(
    ref: MailboxRef,
    q: InboundThreadQuery,
  ): Promise<{ duplicate: boolean; threadId: string; isExistingHamThread: boolean }>;
  findByRfcIds(
    ref: MailboxRef,
    ids: string[],
    providerIds: string[],
  ): Promise<Array<{ id: string; threadId: string | null; source: string | null }>>;
  findSentByIdempotencyKey(
    ref: MailboxRef,
    key: string,
  ): Promise<{ id: string; rfcMessageId: string; externalMessageId: string | null; subject: string | null } | null>;
  countSentSince(ref: MailboxRef, since: number): Promise<number>;
  listScheduled(ref: MailboxRef): Promise<MailMessageRecord[]>;
  listSnoozed(ref: MailboxRef): Promise<SnoozedMessage[]>;
  listSubscriptions(ref: MailboxRef, q: { status?: 'active' | 'unsubscribed' }): Promise<MailSubscription[]>;
  getSubscription(ref: MailboxRef, id: string): Promise<MailSubscription | null>;
  rawSources(
    ref: MailboxRef,
    q: { since: number; limit: number },
  ): Promise<Array<{ id: string; from: MailEmailAddress; subject: string | null; receivedAt: number }>>;
  listDrafts(
    ref: MailboxRef,
    q: { limit: number; cursor?: string },
  ): Promise<{ data: MailDraft[]; hasMore: boolean; cursor: string | null; totalCount: number }>;
  getDraft(ref: MailboxRef, id: string): Promise<MailDraft | null>;
  exportPage(
    ref: MailboxRef,
    q: { cursor?: string; limit: number; sentOnly?: boolean; since?: number; until?: number },
  ): Promise<{ data: MailMessageRecord[]; cursor: string | null }>;

  // writes
  apply(ref: MailboxRef, op: MailboxOp, at?: number): Promise<OpResult>;
  applyBatch(ref: MailboxRef, ops: MailboxOp[], at?: number): Promise<OpResult[]>;
  /**
   * Records ids whose `object`-mode Postgres SECONDARY write failed (design
   * §2.2: "object (Postgres failed): log, then `stub.notePgDrift(ids)`") into
   * the `pg_drift` table (`./schema.ts`), so the alarm can mirror them to
   * Postgres later with backoff — the real counterpart to the router's
   * `mbxpgdrift:<ws>:<acct>` KV placeholder, which stays only as a fallback
   * for when this RPC call itself fails (see `store/router.ts`'s
   * `notePgDriftOrFallback`). Bounded per call (`MAX_PG_DRIFT_IDS_PER_CALL`)
   * so one pathological bulk-op failure can't grow the table unboundedly from
   * a single call; a noted id already pending keeps its existing
   * `attempts`/`next_attempt_at` backoff (only `noted_at` is refreshed) so a
   * repeated failure doesn't reset the clock on its own repair. This task
   * does not implement the alarm-side mirror job itself (draining `pg_drift`
   * into real Postgres writes) — `alarm.ts`'s `candidateAlarmTimes` already
   * reads `pg_drift.next_attempt_at` to schedule for it, but nothing drains
   * it yet; `status().counts.pgDriftPending` is this task's way of making the
   * backlog observable for reverse sync / parity in the meantime.
   */
  notePgDrift(ref: MailboxRef, ids: string[]): Promise<{ accepted: true; noted: number }>;

  // admin
  status(ref: MailboxRef): Promise<MailboxStoreStatus>;
  destroy(ref: MailboxRef): Promise<{ accepted: true }>;
  /**
   * Set by the router/backfill (task C3); see `./alarm`'s header comment.
   * Returns the mode the object had stored before this call (`'postgres'` the
   * first time it's ever told), so the router can log a downgrade warning
   * (design's Risks section) without a separate read.
   */
  setMode(ref: MailboxRef, mode: MailStoreMode): Promise<MailStoreMode>;
}

/**
 * The backfill/catch-up/parity/reverse-sync/rebuild surface (task C4) — kept
 * off `MailboxStoreRpc` itself (see the class's own "backfill, catch-up,
 * parity, reverse sync, rebuild" section comment for why) so callers that
 * need it (the router's `ensureBackfill` call, mail-api's
 * `routes/internal-mail-store`) type their stub as
 * `MailboxStoreRpc & MailboxAdminRpc` instead.
 */
export interface MailboxAdminRpc {
  startBackfill(ref: MailboxRef, options?: StartBackfillOptions): Promise<BackfillState>;
  backfillStatus(ref: MailboxRef): Promise<BackfillState>;
  runParity(ref: MailboxRef, options?: RunParityOptions): Promise<ParityReport>;
  reverseSync(ref: MailboxRef, options: ReverseSyncOptions): Promise<ReverseSyncReport>;
  rebuildMailbox(ref: MailboxRef): Promise<BackfillState>;
}

// ---------------------------------------------------------------------------
// Size thresholds (design §3.7)
// ---------------------------------------------------------------------------

const SIZE_WARN_BYTES = 6 * 1024 ** 3;
const SIZE_CRITICAL_BYTES = 8 * 1024 ** 3;
const SIZE_WARN_THROTTLE_MS = 24 * 60 * 60_000;
const FTS_TRIM_WINDOW_MS = 2 * 365 * 24 * 60 * 60_000;

/**
 * `notePgDrift`'s own bound (design task note 3: "records ids there
 * (bounded)") — matches the chunk size the design already uses for bulk
 * secondary writes (`store/router.ts`'s `rewriteOpForSecondary` rewrites
 * `thread.read`/`folder.read` in chunks of 1000 before they ever reach a
 * secondary store), so one pathological bulk-op failure can add at most one
 * chunk's worth of rows per call rather than growing `pg_drift` unboundedly.
 */
const MAX_PG_DRIFT_IDS_PER_CALL = 1000;

export class MailboxStoreObject extends DurableObject<MailboxStoreObjectEnv> implements MailboxStoreRpc, MailboxAdminRpc {
  constructor(ctx: DurableObjectState, env: MailboxStoreObjectEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => migrateMailbox(ctx.storage));
  }

  // ---- meta helpers ------------------------------------------------------

  private getMeta(key: string): string | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key).toArray()[0];
    return row ? row.value : null;
  }

  private setMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  }

  // ---- ref binding ---------------------------------------------------------

  /**
   * Every public method calls this first. Sets `workspace_id`/`account_id`
   * (and `clerk_org_id`, when given) on the object's first call — the
   * object's own copy of what its Durable Object name already encodes — and
   * rejects a call for a mismatching workspace/account (defence in depth: the
   * object's name is just a hash input, so a caller bug could in principle
   * address the wrong instance). Mirrors `MailIndex.ensureWorkspace`.
   */
  private bindRef(ref: MailboxRef): void {
    const boundWorkspace = this.getMeta('workspace_id');
    const boundAccount = this.getMeta('account_id');
    if (boundWorkspace === null || boundAccount === null) {
      this.setMeta('workspace_id', ref.workspaceId);
      this.setMeta('account_id', ref.accountId);
      if (ref.clerkOrgId) this.setMeta('clerk_org_id', ref.clerkOrgId);
      return;
    }
    if (boundWorkspace !== ref.workspaceId || boundAccount !== ref.accountId) {
      throw new Error(
        `MailboxStoreObject: bound to ${boundWorkspace}:${boundAccount}, called with ${ref.workspaceId}:${ref.accountId}`,
      );
    }
    // clerkOrgId is informational (entity-event dispatch only, see outbox.ts)
    // — refreshed opportunistically, never part of the identity check above.
    if (ref.clerkOrgId && ref.clerkOrgId !== this.getMeta('clerk_org_id')) {
      this.setMeta('clerk_org_id', ref.clerkOrgId);
    }
  }

  /** Reconstructs `ref` from bound meta — used by `alarm()`, which (unlike every RPC method) gets no arguments from Cloudflare. */
  private boundRefOrThrow(): MailboxRef {
    const workspaceId = this.getMeta('workspace_id');
    const accountId = this.getMeta('account_id');
    if (workspaceId === null || accountId === null) {
      throw new Error('MailboxStoreObject: alarm fired before the object was ever bound to a ref');
    }
    return { workspaceId, accountId, clerkOrgId: this.getMeta('clerk_org_id') };
  }

  // ---- backfill-readiness placeholder (writes.ts's own instruction to C1) --

  /**
   * `writes.ts`'s `applyMailboxOp`/`applyMailboxBatch` always return
   * `ready: true` (real backfill-state tracking is task C4's — `./backfill`'s
   * `startBackfill`/`tickBackfill` now write `meta.backfill` for real). This
   * re-derives readiness from `meta.backfill` directly, which is why landing
   * that file required no change here: a write of
   * `meta.backfill = {state: 'done' | ...}` is honoured immediately.
   */
  private isReady(): boolean {
    const raw = this.getMeta('backfill');
    if (raw === null) return true;
    try {
      const parsed = JSON.parse(raw) as { state?: string };
      return parsed.state === 'done';
    } catch {
      return true;
    }
  }

  // ---- wake-on-read (design §3.3, task note 1) ------------------------------

  /**
   * Postgres wakes a snoozed message whose time has passed as a side effect
   * of a plain read (`threads.ts`'s `threadListScope`/`buildWake`); without
   * this, `object`/`object-only` mail never woke except via the explicit
   * `snooze.wake` op and the alarm, so a due snooze could sit in the Snoozed
   * folder until the next alarm tick even while the mailbox was actively
   * being read. Design: "before serving listThreads, stats, labelCounts and
   * unreadCount, the object applies snooze.wake at the current time when
   * anything is due (cheap check first: is any snoozed_until <= now?), in
   * one transaction, then reads."
   *
   * The "cheap check" is `nextSnoozeDueAt`'s indexed `MIN(snoozed_until)` —
   * the same query `writes-extra.ts`'s `applySnoozeWake` already uses to
   * report `OpResult.nextSnoozeDueAt` — so a mailbox with nothing snoozed, or
   * nothing yet due, costs one indexed lookup and nothing else; a write only
   * happens when something has actually come due. Skipped while the object is
   * being torn down (`isDestroying`): a read during that window shouldn't
   * mutate tables the destroy alarm is in the middle of deleting.
   */
  private async wakeOverdueSnoozes(ref: MailboxRef): Promise<void> {
    if (isDestroying(this.ctx.storage.sql)) return;
    const now = Date.now();
    const due = nextSnoozeDueAt(this.ctx.storage.sql);
    if (due === null || due > now) return;
    const storage: WritableStorage = this.ctx.storage;
    const op: MailboxOp = { kind: 'snooze.wake', now };
    const result = applyMailboxOp(storage, ref, op, now);
    await afterWrite(this.ctx, op, result);
  }

  // ---- size thresholds (design §3.7) ---------------------------------------

  /**
   * Called after every successful write. Implements the warn/flag half of
   * design §3.7 (what this task's notes ask for): a throttled structured
   * warning at 6 GB, and a sticky `size_critical` flag — surfaced by
   * `status()` — at 8 GB. It does NOT implement the FTS-row trim job the
   * design additionally describes at 8 GB (`fts_trim_before` driving alarm
   * deletions of old search rows): that's a distinct piece of maintenance
   * work, not part of "the alarm and its outbox" this task covers, so
   * `status().searchTrimmed` stays a placeholder (always `false`) until it
   * lands.
   */
  private checkSize(): void {
    const sizeBytes = this.ctx.storage.sql.databaseSize;
    const now = Date.now();
    if (sizeBytes >= SIZE_CRITICAL_BYTES) {
      if (this.getMeta('size_critical') !== '1') {
        console.error('[mailbox-store] mailbox_store_size:', `level=error sizeBytes=${sizeBytes} ref=${this.getMeta('workspace_id')}:${this.getMeta('account_id')}`);
        this.setMeta('size_critical', '1');
        this.setMeta('fts_trim_before', String(now - FTS_TRIM_WINDOW_MS));
      }
      return;
    }
    if (sizeBytes >= SIZE_WARN_BYTES) {
      const lastWarnedAt = Number(this.getMeta('size_warned_at') ?? '0');
      if (now - lastWarnedAt > SIZE_WARN_THROTTLE_MS) {
        console.warn('[mailbox-store] mailbox_store_size:', `level=warn sizeBytes=${sizeBytes} ref=${this.getMeta('workspace_id')}:${this.getMeta('account_id')}`);
        this.setMeta('size_warned_at', String(now));
      }
    }
  }

  // ---- reads ---------------------------------------------------------------

  async listThreads(ref: MailboxRef, q: ThreadListQuery): Promise<ThreadPage> {
    this.bindRef(ref);
    await this.wakeOverdueSnoozes(ref);
    return reads.listThreads(this.ctx.storage.sql, ref, q);
  }

  async getThread(ref: MailboxRef, threadKey: string): Promise<{ threadId: string; accountId: string; messages: MailMessageRecord[] } | null> {
    this.bindRef(ref);
    return reads.getThread(this.ctx.storage.sql, ref, threadKey);
  }

  async getThreadOfMessage(ref: MailboxRef, messageId: string): Promise<{ threadId: string; messages: MailMessageRecord[] } | null> {
    this.bindRef(ref);
    return reads.getThreadOfMessage(this.ctx.storage.sql, ref, messageId);
  }

  async getMessage(
    ref: MailboxRef,
    id: string,
    o?: { bodies?: boolean; attachments?: boolean },
  ): Promise<(MailMessageRecord & { attachments?: MailAttachmentRecord[] }) | null> {
    this.bindRef(ref);
    return reads.getMessage(this.ctx.storage.sql, ref, id, o);
  }

  async getMessages(ref: MailboxRef, ids: string[]): Promise<MailMessageListRow[]> {
    this.bindRef(ref);
    return reads.getMessages(this.ctx.storage.sql, ref, ids);
  }

  async listMessages(ref: MailboxRef, q: MessageListQuery): Promise<MessagePage> {
    this.bindRef(ref);
    return reads.listMessages(this.ctx.storage.sql, ref, q);
  }

  async stats(ref: MailboxRef): Promise<MailboxStats> {
    this.bindRef(ref);
    await this.wakeOverdueSnoozes(ref);
    return reads.stats(this.ctx.storage.sql);
  }

  async unreadCount(ref: MailboxRef, scope: 'inbox' | 'all-live'): Promise<number> {
    this.bindRef(ref);
    await this.wakeOverdueSnoozes(ref);
    return reads.unreadCount(this.ctx.storage.sql, scope);
  }

  async labelCounts(ref: MailboxRef, keys: FolderKey[]): Promise<Record<FolderKey, LabelCount>> {
    this.bindRef(ref);
    await this.wakeOverdueSnoozes(ref);
    return reads.labelCounts(this.ctx.storage.sql, keys);
  }

  async listAttachments(ref: MailboxRef, messageId: string): Promise<MailAttachmentRecord[]> {
    this.bindRef(ref);
    return reads.listAttachments(this.ctx.storage.sql, messageId);
  }

  async getAttachment(ref: MailboxRef, id: string): Promise<(MailAttachmentRecord & { accountId: string }) | null> {
    this.bindRef(ref);
    return reads.getAttachment(this.ctx.storage.sql, ref, id);
  }

  async recentAttachments(
    ref: MailboxRef,
    q: { before?: { createdAt: number; id: string }; limit: number },
  ): Promise<{ data: MailAttachmentRecord[]; totalCount: number }> {
    this.bindRef(ref);
    return reads.recentAttachments(this.ctx.storage.sql, q);
  }

  async recentAddresses(ref: MailboxRef, limit: number): Promise<string[]> {
    this.bindRef(ref);
    return reads.recentAddresses(this.ctx.storage.sql, limit);
  }

  async resolveInbound(
    ref: MailboxRef,
    q: InboundThreadQuery,
  ): Promise<{ duplicate: boolean; threadId: string; isExistingHamThread: boolean }> {
    this.bindRef(ref);
    return reads.resolveInbound(this.ctx.storage.sql, q);
  }

  async findByRfcIds(
    ref: MailboxRef,
    ids: string[],
    providerIds: string[],
  ): Promise<Array<{ id: string; threadId: string | null; source: string | null }>> {
    this.bindRef(ref);
    return reads.findByRfcIds(this.ctx.storage.sql, ids, providerIds);
  }

  async findSentByIdempotencyKey(
    ref: MailboxRef,
    key: string,
  ): Promise<{ id: string; rfcMessageId: string; externalMessageId: string | null; subject: string | null } | null> {
    this.bindRef(ref);
    return reads.findSentByIdempotencyKey(this.ctx.storage.sql, key);
  }

  async countSentSince(ref: MailboxRef, since: number): Promise<number> {
    this.bindRef(ref);
    return reads.countSentSince(this.ctx.storage.sql, since);
  }

  async listScheduled(ref: MailboxRef): Promise<MailMessageRecord[]> {
    this.bindRef(ref);
    return reads.listScheduled(this.ctx.storage.sql, ref);
  }

  async listSnoozed(ref: MailboxRef): Promise<SnoozedMessage[]> {
    this.bindRef(ref);
    return reads.listSnoozed(this.ctx.storage.sql, ref);
  }

  async listSubscriptions(ref: MailboxRef, q: { status?: 'active' | 'unsubscribed' }): Promise<MailSubscription[]> {
    this.bindRef(ref);
    return reads.listSubscriptions(this.ctx.storage.sql, ref, q);
  }

  async getSubscription(ref: MailboxRef, id: string): Promise<MailSubscription | null> {
    this.bindRef(ref);
    return reads.getSubscription(this.ctx.storage.sql, ref, id);
  }

  async rawSources(
    ref: MailboxRef,
    q: { since: number; limit: number },
  ): Promise<Array<{ id: string; from: MailEmailAddress; subject: string | null; receivedAt: number }>> {
    this.bindRef(ref);
    return reads.rawSources(this.ctx.storage.sql, q);
  }

  async listDrafts(
    ref: MailboxRef,
    q: { limit: number; cursor?: string },
  ): Promise<{ data: MailDraft[]; hasMore: boolean; cursor: string | null; totalCount: number }> {
    this.bindRef(ref);
    return reads.listDrafts(this.ctx.storage.sql, ref, q);
  }

  async getDraft(ref: MailboxRef, id: string): Promise<MailDraft | null> {
    this.bindRef(ref);
    return reads.getDraft(this.ctx.storage.sql, ref, id);
  }

  async exportPage(
    ref: MailboxRef,
    q: { cursor?: string; limit: number; sentOnly?: boolean; since?: number; until?: number },
  ): Promise<{ data: MailMessageRecord[]; cursor: string | null }> {
    this.bindRef(ref);
    return reads.exportPage(this.ctx.storage.sql, ref, q);
  }

  // ---- writes ----------------------------------------------------------------

  async apply(ref: MailboxRef, op: MailboxOp, at?: number): Promise<OpResult> {
    this.bindRef(ref);
    if (isDestroying(this.ctx.storage.sql)) throw new MailboxDestroyedError(ref);
    const storage: WritableStorage = this.ctx.storage;
    const result = applyMailboxOp(storage, ref, op, at ?? Date.now());
    result.ready = this.isReady();
    await afterWrite(this.ctx, op, result);
    this.checkSize();
    return result;
  }

  async applyBatch(ref: MailboxRef, ops: MailboxOp[], at?: number): Promise<OpResult[]> {
    this.bindRef(ref);
    if (isDestroying(this.ctx.storage.sql)) throw new MailboxDestroyedError(ref);
    const storage: WritableStorage = this.ctx.storage;
    const effectiveAt = at ?? Date.now();
    const results = applyMailboxBatch(storage, ref, ops, effectiveAt);
    const ready = this.isReady();
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      result.ready = ready;
      // eslint-disable-next-line no-await-in-loop -- each afterWrite call only ever tightens the same alarm; sequential keeps the "only move earlier" bookkeeping simple to reason about
      await afterWrite(this.ctx, ops[i]!, result);
    }
    this.checkSize();
    return results;
  }

  // ---- admin -------------------------------------------------------------

  async status(ref: MailboxRef): Promise<MailboxStoreStatus> {
    this.bindRef(ref);
    const sql = this.ctx.storage.sql;
    const count = (table: string, where = ''): number =>
      sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}${where}`).toArray()[0]?.n ?? 0;
    const sqliteVersion = sql.exec<{ v: string }>('SELECT sqlite_version() AS v').toArray()[0]?.v ?? 'unknown';
    return {
      schemaVersion: getSchemaVersion(this.ctx.storage),
      workspaceId: this.getMeta('workspace_id'),
      accountId: this.getMeta('account_id'),
      clerkOrgId: this.getMeta('clerk_org_id'),
      mode: getStoredMode(sql),
      counts: {
        messages: count('messages', ' WHERE deleted_at IS NULL'),
        threads: count('threads'),
        attachments: count('attachments', ' WHERE deleted_at IS NULL'),
        drafts: count('drafts', ' WHERE deleted_at IS NULL'),
        subscriptions: count('subscriptions'),
        outboxPending: count('outbox'),
        pgDriftPending: count('pg_drift'),
      },
      databaseSize: sql.databaseSize,
      sqliteVersion,
      sizeWarning: this.getMeta('size_warned_at') !== null,
      sizeCritical: this.getMeta('size_critical') === '1',
      searchTrimmed: false,
      destroying: isDestroying(sql),
      ready: this.isReady(),
    };
  }

  async destroy(ref: MailboxRef): Promise<{ accepted: true }> {
    this.bindRef(ref);
    beginDestroy(this.ctx.storage, Date.now());
    await recomputeAlarm(this.ctx);
    return { accepted: true };
  }

  async setMode(ref: MailboxRef, mode: MailStoreMode): Promise<MailStoreMode> {
    this.bindRef(ref);
    const previous = setStoredMode(this.ctx.storage.sql, mode);
    await recomputeAlarm(this.ctx);
    return previous;
  }

  /**
   * See this method's own doc on `MailboxStoreRpc` above. Upserts into
   * `pg_drift` (keyed by `message_id`) rather than inserting blindly, so a
   * message that fails its Postgres mirror repeatedly only refreshes
   * `noted_at` — its existing `attempts`/`next_attempt_at` backoff (once
   * something actually drains this table) is left alone, not reset to "retry
   * immediately" on every fresh failure.
   */
  async notePgDrift(ref: MailboxRef, ids: string[]): Promise<{ accepted: true; noted: number }> {
    this.bindRef(ref);
    const bounded = ids.slice(0, MAX_PG_DRIFT_IDS_PER_CALL);
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      for (const id of bounded) {
        this.ctx.storage.sql.exec(
          `INSERT INTO pg_drift (message_id, noted_at, attempts, next_attempt_at) VALUES (?, ?, 0, ?)
           ON CONFLICT(message_id) DO UPDATE SET noted_at = excluded.noted_at`,
          id,
          now,
          now,
        );
      }
    });
    await recomputeAlarm(this.ctx, now);
    return { accepted: true, noted: bounded.length };
  }

  // ---- backfill, catch-up, parity, reverse sync, rebuild (task C4) --------
  //
  // Not on `MailboxStoreRpc` (the admin/maintenance surface is narrower than
  // every caller of the mailbox needs, and adding required methods there
  // would also require updating `store/object/testing/fake-stub.ts`'s
  // hand-written forwarding object, owned by a parallel task in this
  // worktree) — callers that need them (the router's `ensureBackfill` call,
  // the mail-api admin routes) go through `mailboxStubFor(...)` and call
  // these directly; the class still implements them for real.

  /**
   * Cheap and idempotent (design §4, task notes: "make that call cheap and
   * idempotent — no-op when running/done"): `./backfill`'s own `startBackfill`
   * already short-circuits without a write when a run is in progress or done;
   * this only registers the alarm continuation (and nudges the alarm) the
   * first time a call actually starts a fresh run, detected by the returned
   * state's `startedAt` matching this call's own clock — a no-op return keeps
   * whatever `startedAt` the existing run already had.
   */
  async startBackfill(ref: MailboxRef, options?: StartBackfillOptions): Promise<BackfillState> {
    this.bindRef(ref);
    const now = Date.now();
    const state = startBackfill(this.ctx.storage.sql, now, options);
    if (state.startedAt === now && (state.state === 'running' || state.state === 'catchup')) {
      registerMaintenanceContinuation(this.ctx.storage.sql);
      await recomputeAlarm(this.ctx, now);
    }
    return state;
  }

  async backfillStatus(ref: MailboxRef): Promise<BackfillState> {
    this.bindRef(ref);
    return backfillStatus(this.ctx.storage.sql);
  }

  /** `./parity.ts`'s `runParity` — see that file's header for pagination/repair semantics. */
  async runParity(ref: MailboxRef, options?: RunParityOptions): Promise<ParityReport> {
    this.bindRef(ref);
    const storage: WritableStorage = this.ctx.storage;
    return runParity(storage, this.env, ref, options);
  }

  /** `./reverse-sync.ts`'s `runReverseSync` — required before a mode downgrade from `object`/`object-only`; see that file's header for the rollback runbook. */
  async reverseSync(ref: MailboxRef, options: ReverseSyncOptions): Promise<ReverseSyncReport> {
    this.bindRef(ref);
    return runReverseSync(this.ctx.storage, this.env, ref, options);
  }

  /** `./backfill.ts`'s `rebuildMailbox` — admin-only: wipes every data table this object owns and restarts backfill from scratch. Always does real work (never short-circuits like `startBackfill`), so this always (re-)registers the continuation. */
  async rebuildMailbox(ref: MailboxRef): Promise<BackfillState> {
    this.bindRef(ref);
    const storage: WritableStorage = this.ctx.storage;
    const state = rebuildMailbox(storage, Date.now());
    registerMaintenanceContinuation(this.ctx.storage.sql);
    await recomputeAlarm(this.ctx);
    return state;
  }

  // ---- alarm ---------------------------------------------------------------

  async alarm(): Promise<void> {
    const ref = this.boundRefOrThrow();
    const env: AlarmEnv = this.env;
    await runAlarm(this.ctx, env, ref);
  }
}
