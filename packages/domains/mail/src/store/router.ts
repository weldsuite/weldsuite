/**
 * The mailbox store router (design §2.2, task C3): `RoutedMailboxStore`/
 * `RoutedWorkspaceMailStore` pick Postgres or the object per mode, dual-write
 * in `shadow`/`object`, and sample parity in `shadow`. This is the one place
 * a caller (D-group consumer tasks) needs to know about — it implements the
 * same `MailboxStore`/`WorkspaceMailStore` contracts `store/postgres/*` and
 * `store/object/*` do, so nothing downstream branches on mode itself.
 *
 * Mode table (`postgres` is the default for every workspace, so it MUST NOT
 * add a query, a KV/object call, or any behaviour — `postgres` mode never
 * touches `adminEnv`/`kv`/`parity`, only `this.postgres`):
 *
 * | mode         | primary (awaited)    | secondary (`waitUntil`) | reads                          |
 * |--------------|----------------------|--------------------------|--------------------------------|
 * | postgres     | Postgres             | none                     | Postgres                       |
 * | shadow       | Postgres             | object                   | Postgres; parity sampled       |
 * | object       | object               | Postgres                 | object; falls back on failure  |
 * | object-only  | object               | none                     | object; no fallback            |
 *
 * **Readiness, single mailbox (`RoutedMailboxStore.routedRead`).**
 * `object`/`object-only` reads demote to Postgres for a mailbox whose object
 * hasn't finished backfill (`status().ready`, probed via the Durable Object's
 * admin RPC and cached per isolate for 60s, refreshed from every write's
 * `OpResult.ready` too) — this demotion applies even in `object-only`, since
 * the alternative is reading an object that may not have every row yet.
 *
 * **Readiness, cross-mailbox (`RoutedWorkspaceMailStore.crossMailboxRead`).**
 * The unified reads (unified inbox/stats, the unread badge, counterparty,
 * locate, the various cross-mailbox lists) fan out to every mailbox in
 * `accountIds` at once, so "demote to Postgres" can't be decided per mailbox
 * the way the single-mailbox case does — it's all-or-nothing for the whole
 * read. In `object` mode, Postgres is complete for every mailbox regardless
 * of backfill (writes are always dual-written there — see the mode table),
 * so ANY not-ready mailbox in scope demotes the WHOLE read to Postgres (the
 * same per-isolate readiness cache the single-mailbox case probes). In
 * `object-only` there is no secondary Postgres write at all, so Postgres is
 * never a safe fallback there — a not-ready mailbox in `object-only` is an
 * operator precondition violation (object-only is only meant to be switched
 * on once every mailbox has finished backfill), logged once per isolate per
 * mailbox rather than silently demoted or left to error.
 *
 * **Telling the object its mode.** The object never reads Flagship (it has no
 * way to); the router calls `setMode(ref, mode)` on first use of a mailbox
 * under a mode it hasn't been told yet, at most once per isolate per
 * (mailbox, mode) (an isolate-cached map, so repeat requests in the same
 * isolate cost nothing). `setMode` returns the mode the object had stored
 * before this call; `isDowngrade(previous, mode)` (`./mode`) decides whether
 * to log a downgrade warning (design's Risks section: a downgrade from
 * `object`/`object-only` needs a `reverseSync`, task C4, run first).
 *
 * **Secondary write failures never fail the request.** They're logged
 * (`mailbox_secondary_write_failed`), counted (`getSecondaryFailureCount`,
 * test/metrics seam), and the repair hand-off task C4 consumes is set for
 * both directions:
 *  - `shadow` (object secondary failed): a KV marker, `mbxdrift:<ws>:<acct>`
 *    (design §2.2's own name for this direction) — there's still no object
 *    RPC for it, so this stays KV-only.
 *  - `object` (Postgres secondary failed): the object's own `pg_drift` table,
 *    via its `notePgDrift(ref, ids)` RPC (design: "`stub.notePgDrift(ids)`") —
 *    `notePgDriftOrFallback` tries that first and only falls back to the KV
 *    placeholder `mbxpgdrift:<ws>:<acct>` when the RPC call itself fails
 *    (binding missing, the object unreachable, no ids to note). See this
 *    file's exported `markMailboxDrift` for the KV marker's exact shape.
 *
 * An `OpResult` with non-empty `missing` is NOT a failure (the object may
 * simply not have a row yet, mid-backfill — design: "missing ids while
 * backfill is still running are not failures") — only a THROWN error from the
 * secondary counts.
 */

import { mailboxKeyFor, mailboxStubFor, type MailboxStoreNamespaceEnv } from './object';
import { isDowngrade } from './mode';
import {
  ParitySampler,
  logParityMismatch,
  type ParityMismatchHandler,
} from './parity';
import type {
  FolderKey,
  InboundThreadQuery,
  LabelCount,
  MailAttachmentRecord,
  MailboxOp,
  MailboxRef,
  MailboxStats,
  MailboxStore,
  MailMessageListRow,
  MailMessageRecord,
  MailStoreMode,
  MarkFolderReadOptions,
  MessageCursor,
  MessageListQuery,
  MessagePage,
  OpResult,
  SnoozedMessage,
  ThreadFilter,
  ThreadListQuery,
  ThreadPage,
  WorkspaceMailStore,
} from './types';

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function chunk<T>(items: readonly T[], size: number): T[][] {
  if (items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Every id a `MailboxOp` touches — for the secondary-failure repair hand-off
 * (`markMailboxDrift`'s `sampleIds`). The exhaustive `default` is the actual
 * safety net: a new `MailboxOp` kind must be classified here before it
 * compiles, same discipline as `store/object/stub.ts`'s `isRetryableOp`.
 */
function idsOfOp(op: MailboxOp): string[] {
  switch (op.kind) {
    case 'ingest':
      return [op.message.id];
    case 'flags':
    case 'labels.add':
    case 'labels.remove':
    case 'move':
    case 'delete':
      return op.ids;
    case 'labels.set':
      return [op.id];
    case 'thread.label':
    case 'thread.read':
      return [op.threadKey];
    case 'folder.read':
      return [];
    case 'thread.set':
      return [op.id];
    case 'label.rename':
    case 'label.delete':
      return [];
    case 'snooze':
    case 'resnooze':
    case 'unsnooze':
      return [op.id];
    case 'snooze.wake':
      return [];
    case 'scheduled':
      return [op.id];
    case 'delivery.match':
      return [];
    case 'inbound.finalize':
      return [op.id];
    case 'categories':
      return [op.id];
    case 'attachment.create':
      return [op.attachment.id];
    case 'attachment.update':
    case 'attachment.delete':
      return [op.id];
    case 'attachment.associate':
      return [op.messageId, ...op.attachmentIds];
    case 'subscription.upsert':
      return [];
    case 'subscription.status':
      return [op.id];
    case 'draft.create':
      return [op.draft.id];
    case 'draft.update':
    case 'draft.delete':
      return [op.id];
    default: {
      const exhaustive: never = op;
      throw new Error(`idsOfOp: unhandled MailboxOp kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Rewrites one op from the PRIMARY's result before it goes to the secondary
 * (design §2.2 "Making the secondary deterministic"). Everything not listed
 * here passes through unchanged — most ops are already deterministic
 * (absolute id lists, absolute patches), so there is nothing to rewrite.
 */
export function rewriteOpForSecondary(op: MailboxOp, primaryResult: OpResult): MailboxOp[] {
  switch (op.kind) {
    case 'ingest': {
      const threadId = primaryResult.ingest?.threadKey ?? op.message.threadId;
      return [{ kind: 'ingest', message: { ...op.message, threadId } }];
    }
    case 'thread.read': {
      const ids = primaryResult.updatedIds ?? [];
      return chunk(ids, 1000).map((idsChunk) => ({
        kind: 'flags' as const,
        ids: idsChunk,
        patch: { isRead: op.isRead },
        semantics: 'bulk' as const,
      }));
    }
    case 'folder.read': {
      const ids = primaryResult.updatedIds ?? [];
      return chunk(ids, 1000).map((idsChunk) => ({
        kind: 'flags' as const,
        ids: idsChunk,
        patch: { isRead: true },
        semantics: 'bulk' as const,
      }));
    }
    case 'snooze.wake':
      // Design: "snooze.wake is never dual-written: each store wakes on its own rule."
      return [];
    default:
      return [op];
  }
}

// ---------------------------------------------------------------------------
// Isolate-level state: readiness cache, "told the object its mode" cache,
// secondary-failure counters. Module-scope by design (mirrors `./mode`'s
// `modeCache`): cheap to keep warm across requests in the same isolate, and
// deliberately NOT request-scoped — a mailbox's readiness and the mode the
// object was last told about don't change within one request either way.
// ---------------------------------------------------------------------------

/** design §2.2: "`status()` is cached per isolate for 60 s, and a write result's `ready` updates the cache." */
const READINESS_TTL_MS = 60_000;

interface ReadinessEntry {
  ready: boolean;
  expiresAt: number;
}

const readinessCache = new Map<string, ReadinessEntry>();
const notifiedModes = new Map<string, MailStoreMode>();
const secondaryFailureCounts = new Map<string, number>();
/** `RoutedWorkspaceMailStore.warnIfAnyNotReady`'s "once per isolate per mailbox" set — see `warnObjectOnlyNotReady`. */
const objectOnlyNotReadyWarned = new Set<string>();

export type SecondaryDirection = 'pg-to-object' | 'object-to-pg';

function failureCountKey(ref: MailboxRef, direction: SecondaryDirection): string {
  return `${mailboxKeyFor(ref)}:${direction}`;
}

function bumpSecondaryFailureCount(ref: MailboxRef, direction: SecondaryDirection): void {
  const key = failureCountKey(ref, direction);
  secondaryFailureCounts.set(key, (secondaryFailureCounts.get(key) ?? 0) + 1);
}

/** Test/metrics seam: how many times a mailbox's secondary write has failed, this isolate, since the last reset. */
export function getSecondaryFailureCount(ref: MailboxRef, direction: SecondaryDirection): number {
  return secondaryFailureCounts.get(failureCountKey(ref, direction)) ?? 0;
}

/** Test-only: clears every isolate-level cache this module keeps, so tests don't leak into each other. */
export function __resetMailRouterStateForTests(): void {
  readinessCache.clear();
  notifiedModes.clear();
  secondaryFailureCounts.clear();
  objectOnlyNotReadyWarned.clear();
}

function cachedReadiness(key: string, now: number): boolean | undefined {
  const entry = readinessCache.get(key);
  if (!entry || entry.expiresAt <= now) return undefined;
  return entry.ready;
}

function setCachedReadiness(ref: MailboxRef, ready: boolean, now: number): void {
  readinessCache.set(mailboxKeyFor(ref), { ready, expiresAt: now + READINESS_TTL_MS });
}

/** `OpResult.ready` from any write (either store) updates the cache — design §2.2. */
export function noteReadinessFromWrite(ref: MailboxRef, ready: boolean, now: number = Date.now()): void {
  setCachedReadiness(ref, ready, now);
}

/**
 * Whether `ref`'s object has finished backfill, probed via the Durable
 * Object's `status()` admin RPC (`mailbox-object/mailbox-object.ts`, task C1)
 * through the single sanctioned stub lookup (`mailboxStubFor`). Cached per
 * isolate for 60s; a probe failure (binding missing, RPC error) fails OPEN —
 * assumes ready, so a broken probe degrades to "no demotion" rather than
 * routing every read to Postgres.
 */
async function probeReadiness(adminEnv: MailboxStoreNamespaceEnv, ref: MailboxRef, now: number): Promise<boolean> {
  const cached = cachedReadiness(mailboxKeyFor(ref), now);
  if (cached !== undefined) return cached;
  try {
    const status = await mailboxStubFor(adminEnv, ref).status(ref);
    setCachedReadiness(ref, status.ready, now);
    return status.ready;
  } catch (err) {
    console.warn('[mail-store] status() probe failed, assuming ready:', err instanceof Error ? err.message : err);
    return true;
  }
}

/**
 * `RoutedWorkspaceMailStore`'s `object-only` cross-mailbox readiness warning
 * (this file's header comment, design task note 2: "object-only should only
 * be switched on after every mailbox is ready"). Logged once per isolate per
 * mailbox, not on every request that happens to touch it — a persistently
 * not-ready mailbox in `object-only` is an operator configuration problem,
 * not something worth a warning per page load.
 */
function warnObjectOnlyNotReady(ref: MailboxRef): void {
  const key = mailboxKeyFor(ref);
  if (objectOnlyNotReadyWarned.has(key)) return;
  objectOnlyNotReadyWarned.add(key);
  console.warn(
    '[mail-store] object-only cross-mailbox read before backfill finished — object-only should only be switched on once every mailbox is ready:',
    JSON.stringify({ workspaceId: ref.workspaceId, accountId: ref.accountId }),
  );
}

/**
 * Tells the object which mode it's being used under, at most once per
 * isolate per (mailbox, mode) — the isolate cache IS the "at most once"
 * guarantee; a failed call leaves the cache untouched so the next use retries
 * rather than silently giving up forever. Logs a downgrade warning
 * (design's Risks section) from `setMode`'s returned previous mode.
 */
async function ensureObjectKnowsMode(adminEnv: MailboxStoreNamespaceEnv, ref: MailboxRef, mode: MailStoreMode): Promise<void> {
  const key = mailboxKeyFor(ref);
  if (notifiedModes.get(key) === mode) return;
  try {
    const previous = await mailboxStubFor(adminEnv, ref).setMode(ref, mode);
    notifiedModes.set(key, mode);
    if (isDowngrade(previous, mode)) {
      console.warn(
        '[mail-store] mailbox mode downgrade:',
        JSON.stringify({ workspaceId: ref.workspaceId, accountId: ref.accountId, from: previous, to: mode }),
      );
    }
  } catch (err) {
    console.warn('[mail-store] setMode failed, will retry on next use:', err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Drift marker (the repair hand-off task C4 consumes)
// ---------------------------------------------------------------------------

/** 1 day — design §2.2's own number for the `shadow`-direction marker; reused for both directions. */
export const MAILBOX_DRIFT_TTL_SECONDS = 24 * 60 * 60;

function mailboxDriftKey(ref: MailboxRef): string {
  return `mbxdrift:${ref.workspaceId}:${ref.accountId}`;
}

/** This task's placeholder for design's `stub.notePgDrift(ids)` (the `object`-mode direction): that RPC needs the `pg_drift` table task C4 adds to the object, which doesn't exist yet. Same KV-marker shape so C4 can read either one; swap this for the real RPC once it lands. */
function mailboxPgDriftKey(ref: MailboxRef): string {
  return `mbxpgdrift:${ref.workspaceId}:${ref.accountId}`;
}

export interface MailboxDriftMarker {
  at: number;
  lastKind: string;
  count: number;
  /** Capped at 20 — enough for a human or task C4's repair job to sample without the marker growing unbounded. */
  sampleIds: string[];
}

/**
 * Only `put` is ever called on the drift marker's KV binding — narrowed to
 * that one structural method (rather than the full ambient `KVNamespace`,
 * referenced here without an explicit `@cloudflare/workers-types` import so
 * it resolves to whichever ambient `KVNamespace` the consuming worker's own
 * tsconfig `types` loads, the same one `PermissionsCacheEnv.WORKSPACE_CACHE`
 * — the value every caller actually passes in — is typed against). A plain
 * `KVNamespace` alias here would pick up `@cloudflare/workers-types`'s
 * explicit module export instead, which is a structurally different `get()`
 * overload set from the ambient one and fails to type-check against it.
 */
type DriftKv = Pick<KVNamespace, 'put'>;

/** Sets the KV drift marker for `ref`, never throwing (a failed write here only delays repair, it must not fail the caller). */
export async function markMailboxDrift(
  kv: DriftKv,
  ref: MailboxRef,
  direction: SecondaryDirection,
  info: { kind: string; ids: string[] },
): Promise<void> {
  const key = direction === 'pg-to-object' ? mailboxDriftKey(ref) : mailboxPgDriftKey(ref);
  const marker: MailboxDriftMarker = { at: Date.now(), lastKind: info.kind, count: info.ids.length, sampleIds: info.ids.slice(0, 20) };
  try {
    await kv.put(key, JSON.stringify(marker), { expirationTtl: MAILBOX_DRIFT_TTL_SECONDS });
  } catch (err) {
    console.warn('[mail-store] failed to set the mailbox drift marker:', err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// RoutedMailboxStore
// ---------------------------------------------------------------------------

export interface RoutedMailboxStoreDeps {
  ref: MailboxRef;
  mode: MailStoreMode;
  postgres: MailboxStore;
  /** Required for every mode except `postgres`. */
  object?: MailboxStore;
  /** For `setMode`/`status()` via `mailboxStubFor` — required for every mode except `postgres`. */
  adminEnv?: MailboxStoreNamespaceEnv;
  /** `WORKSPACE_CACHE`, for the drift marker — required for every mode except `postgres`. */
  kv?: DriftKv;
  waitUntil: (p: Promise<unknown>) => void;
  /** Present only in `shadow` mode. */
  parity?: ParitySampler;
  now?: () => number;
}

export class RoutedMailboxStore implements MailboxStore {
  readonly ref: MailboxRef;
  readonly backend: 'postgres' | 'object';
  private readonly mode: MailStoreMode;
  private readonly postgres: MailboxStore;
  private readonly object?: MailboxStore;
  private readonly adminEnv?: MailboxStoreNamespaceEnv;
  private readonly kv?: DriftKv;
  private readonly waitUntilFn: (p: Promise<unknown>) => void;
  private readonly parity?: ParitySampler;
  private readonly now: () => number;

  constructor(deps: RoutedMailboxStoreDeps) {
    this.ref = deps.ref;
    this.mode = deps.mode;
    this.postgres = deps.postgres;
    this.object = deps.object;
    this.adminEnv = deps.adminEnv;
    this.kv = deps.kv;
    this.waitUntilFn = deps.waitUntil;
    this.parity = deps.parity;
    this.now = deps.now ?? Date.now;
    this.backend = this.mode === 'object' || this.mode === 'object-only' ? 'object' : 'postgres';

    // Fire-and-forget, gated by the isolate cache inside `ensureObjectKnowsMode`
    // itself — safe to "call" on every construction; it's a no-op RPC-wise
    // once the object already knows this mode.
    if (this.mode !== 'postgres' && this.adminEnv) {
      this.waitUntilFn(ensureObjectKnowsMode(this.adminEnv, this.ref, this.mode));
    }
  }

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  /**
   * `postgres` → Postgres, no questions asked. `shadow` → Postgres (the
   * caller may layer parity sampling on top via `postgresWithParity`).
   * `object`/`object-only` → demote to Postgres when not ready, else the
   * object; a thrown error falls back to Postgres in `object` only.
   */
  private async routedRead<T>(objectCall: (store: MailboxStore) => Promise<T>, postgresCall: () => Promise<T>): Promise<T> {
    if (this.mode === 'postgres' || this.mode === 'shadow') return postgresCall();

    const ready = this.adminEnv ? await probeReadiness(this.adminEnv, this.ref, this.now()) : true;
    if (!ready) return postgresCall();

    try {
      return await objectCall(this.object!);
    } catch (err) {
      if (this.mode === 'object-only') throw err;
      console.error('[mail-store] object read failed, falling back to Postgres:', err instanceof Error ? err.message : err);
      return postgresCall();
    }
  }

  /** `shadow`-only: runs the Postgres read, then samples parity against the object in the background. A no-op outside `shadow` (or with no object/parity wired). */
  private async postgresWithParity<T>(run: () => Promise<T>, sample: (result: T) => Promise<void> | null): Promise<T> {
    const result = await run();
    if (this.mode === 'shadow' && this.object && this.parity) {
      const pending = sample(result);
      if (pending) this.waitUntilFn(pending);
    }
    return result;
  }

  listThreads(q: ThreadListQuery): Promise<ThreadPage> {
    return this.routedRead(
      (o) => o.listThreads(q),
      () => this.postgresWithParity(() => this.postgres.listThreads(q), (result) => this.parity!.sampleListThreads(this.ref, q, result, this.object!)),
    );
  }

  getThread(threadKey: string) {
    return this.routedRead((o) => o.getThread(threadKey), () => this.postgres.getThread(threadKey));
  }

  getThreadOfMessage(messageId: string) {
    return this.routedRead((o) => o.getThreadOfMessage(messageId), () => this.postgres.getThreadOfMessage(messageId));
  }

  getMessage(id: string, o?: { bodies?: boolean; attachments?: boolean }) {
    return this.routedRead((store) => store.getMessage(id, o), () => this.postgres.getMessage(id, o));
  }

  getMessages(ids: string[], opts?: { includeDeleted?: boolean }): Promise<MailMessageListRow[]> {
    return this.routedRead((o) => o.getMessages(ids, opts), () => this.postgres.getMessages(ids, opts));
  }

  listMessages(q: MessageListQuery): Promise<MessagePage> {
    return this.routedRead((o) => o.listMessages(q), () => this.postgres.listMessages(q));
  }

  stats(): Promise<MailboxStats> {
    return this.routedRead(
      (o) => o.stats(),
      () => this.postgresWithParity(() => this.postgres.stats(), (result) => this.parity!.sampleStats(this.ref, result, this.object!)),
    );
  }

  unreadCount(scope: 'inbox' | 'all-live'): Promise<number> {
    return this.routedRead((o) => o.unreadCount(scope), () => this.postgres.unreadCount(scope));
  }

  labelCounts(keys: FolderKey[]): Promise<Record<FolderKey, LabelCount>> {
    return this.routedRead((o) => o.labelCounts(keys), () => this.postgres.labelCounts(keys));
  }

  listAttachments(messageId: string): Promise<MailAttachmentRecord[]> {
    return this.routedRead((o) => o.listAttachments(messageId), () => this.postgres.listAttachments(messageId));
  }

  getAttachment(id: string): Promise<(MailAttachmentRecord & { accountId: string }) | null> {
    return this.routedRead((o) => o.getAttachment(id), () => this.postgres.getAttachment(id));
  }

  recentAttachments(q: { before?: { createdAt: number; id: string }; limit: number }) {
    return this.routedRead((o) => o.recentAttachments(q), () => this.postgres.recentAttachments(q));
  }

  recentAddresses(limit: number): Promise<string[]> {
    return this.routedRead((o) => o.recentAddresses(limit), () => this.postgres.recentAddresses(limit));
  }

  resolveInbound(q: InboundThreadQuery) {
    return this.routedRead((o) => o.resolveInbound(q), () => this.postgres.resolveInbound(q));
  }

  findByRfcIds(ids: string[], providerIds: string[]) {
    return this.routedRead((o) => o.findByRfcIds(ids, providerIds), () => this.postgres.findByRfcIds(ids, providerIds));
  }

  findSentByIdempotencyKey(key: string) {
    return this.routedRead((o) => o.findSentByIdempotencyKey(key), () => this.postgres.findSentByIdempotencyKey(key));
  }

  countSentSince(since: number): Promise<number> {
    return this.routedRead((o) => o.countSentSince(since), () => this.postgres.countSentSince(since));
  }

  listScheduled(): Promise<MailMessageRecord[]> {
    return this.routedRead((o) => o.listScheduled(), () => this.postgres.listScheduled());
  }

  listSnoozed(): Promise<SnoozedMessage[]> {
    return this.routedRead((o) => o.listSnoozed(), () => this.postgres.listSnoozed());
  }

  listSubscriptions(q: { status?: 'active' | 'unsubscribed' }) {
    return this.routedRead((o) => o.listSubscriptions(q), () => this.postgres.listSubscriptions(q));
  }

  getSubscription(id: string) {
    return this.routedRead((o) => o.getSubscription(id), () => this.postgres.getSubscription(id));
  }

  rawSources(q: { since: number; limit: number }) {
    return this.routedRead((o) => o.rawSources(q), () => this.postgres.rawSources(q));
  }

  listDrafts(q: { limit: number; cursor?: string }) {
    return this.routedRead((o) => o.listDrafts(q), () => this.postgres.listDrafts(q));
  }

  getDraft(id: string) {
    return this.routedRead((o) => o.getDraft(id), () => this.postgres.getDraft(id));
  }

  exportPage(q: { cursor?: string; limit: number; sentOnly?: boolean; since?: number; until?: number }) {
    return this.routedRead((o) => o.exportPage(q), () => this.postgres.exportPage(q));
  }

  // ---------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------

  async apply(op: MailboxOp, at?: number): Promise<OpResult> {
    const effectiveAt = at ?? this.now();
    if (this.mode === 'postgres') return this.postgres.apply(op, effectiveAt);

    if (this.mode === 'object-only') {
      const result = await this.object!.apply(op, effectiveAt);
      noteReadinessFromWrite(this.ref, result.ready, this.now());
      return result;
    }

    const [primary, secondary] = this.mode === 'shadow' ? ([this.postgres, this.object!] as const) : ([this.object!, this.postgres] as const);
    const result = await primary.apply(op, effectiveAt);
    if (primary === this.object) noteReadinessFromWrite(this.ref, result.ready, this.now());

    const secondaryOps = rewriteOpForSecondary(op, result);
    if (secondaryOps.length > 0) this.waitUntilFn(this.applySecondary(secondary, secondaryOps, effectiveAt));
    return result;
  }

  async applyBatch(ops: MailboxOp[], at?: number): Promise<OpResult[]> {
    const effectiveAt = at ?? this.now();
    if (this.mode === 'postgres') return this.postgres.applyBatch(ops, effectiveAt);

    if (this.mode === 'object-only') {
      const results = await this.object!.applyBatch(ops, effectiveAt);
      const last = results.at(-1);
      if (last) noteReadinessFromWrite(this.ref, last.ready, this.now());
      return results;
    }

    const [primary, secondary] = this.mode === 'shadow' ? ([this.postgres, this.object!] as const) : ([this.object!, this.postgres] as const);
    const results = await primary.applyBatch(ops, effectiveAt);
    if (primary === this.object) {
      const last = results.at(-1);
      if (last) noteReadinessFromWrite(this.ref, last.ready, this.now());
    }

    const secondaryOps = ops.flatMap((op, i) => rewriteOpForSecondary(op, results[i]!));
    if (secondaryOps.length > 0) this.waitUntilFn(this.applySecondary(secondary, secondaryOps, effectiveAt));
    return results;
  }

  /**
   * Used by `RoutedWorkspaceMailStore.markFolderRead` in `shadow` mode: the
   * primary write already happened as one cross-mailbox Postgres call, so
   * only this mailbox's object secondary needs these (already-rewritten)
   * ops. Goes through the exact same failure handling as a normal dual
   * write.
   */
  applyToObjectSecondaryOnly(ops: MailboxOp[], at: number): void {
    if (!this.object || ops.length === 0) return;
    this.waitUntilFn(this.applySecondary(this.object, ops, at));
  }

  private async applySecondary(store: MailboxStore, ops: MailboxOp[], at: number): Promise<void> {
    const direction: SecondaryDirection = store === this.object ? 'pg-to-object' : 'object-to-pg';
    try {
      const results = await store.applyBatch(ops, at);
      if (direction === 'pg-to-object') {
        const last = results.at(-1);
        if (last) noteReadinessFromWrite(this.ref, last.ready, this.now());
      }
    } catch (err) {
      this.handleSecondaryFailure(direction, ops, err);
    }
  }

  private handleSecondaryFailure(direction: SecondaryDirection, ops: MailboxOp[], err: unknown): void {
    const ids = ops.flatMap(idsOfOp);
    const kind = ops[0]?.kind ?? 'unknown';
    console.error(
      '[mail-store] mailbox_secondary_write_failed',
      JSON.stringify({
        workspaceId: this.ref.workspaceId,
        accountId: this.ref.accountId,
        kind,
        ids,
        direction,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    bumpSecondaryFailureCount(this.ref, direction);
    if (direction === 'object-to-pg') {
      this.waitUntilFn(this.notePgDriftOrFallback(ids, kind));
      return;
    }
    if (this.kv) this.waitUntilFn(markMailboxDrift(this.kv, this.ref, direction, { kind, ids }));
  }

  /**
   * The `object`-direction repair hand-off (design: "object (Postgres
   * failed): log, then `stub.notePgDrift(ids)`"): records the failed op's ids
   * in the object's own `pg_drift` table via its RPC, so the object's alarm
   * can mirror them to Postgres later with backoff — a real, durable table
   * instead of the KV placeholder `mbxpgdrift:<ws>:<acct>` this file used to
   * set unconditionally for this direction. The KV marker stays as a
   * fallback ONLY: when there's nothing to note (no ids — some ops, like
   * `label.rename`/`delivery.match`, touch no specific id), when `adminEnv`
   * isn't wired, or when the RPC call itself throws (binding missing, the
   * object unreachable) — in every one of those cases the KV marker is still
   * the only way to surface that this mailbox has unrepaired drift.
   */
  private async notePgDriftOrFallback(ids: string[], kind: string): Promise<void> {
    if (ids.length > 0 && this.adminEnv) {
      try {
        await mailboxStubFor(this.adminEnv, this.ref).notePgDrift(this.ref, ids);
        return;
      } catch (err) {
        console.warn('[mail-store] notePgDrift RPC failed, falling back to the KV marker:', err instanceof Error ? err.message : err);
      }
    }
    if (this.kv) await markMailboxDrift(this.kv, this.ref, 'object-to-pg', { kind, ids });
  }
}

// ---------------------------------------------------------------------------
// RoutedWorkspaceMailStore
// ---------------------------------------------------------------------------

export interface RoutedWorkspaceMailStoreDeps {
  workspaceId: string;
  clerkOrgId: string;
  mode: MailStoreMode;
  postgresWorkspace: WorkspaceMailStore;
  /** Required for every mode except `postgres`. */
  objectWorkspace?: WorkspaceMailStore;
  adminEnv?: MailboxStoreNamespaceEnv;
  kv?: DriftKv;
  waitUntil: (p: Promise<unknown>) => void;
  /** `shadow`-mode parity sample rate; ignored otherwise. Defaults inside `ParitySampler` when omitted. */
  parityRate?: number;
  parityRandom?: () => number;
  parityOnMismatch?: ParityMismatchHandler;
  now?: () => number;
}

export class RoutedWorkspaceMailStore implements WorkspaceMailStore {
  readonly workspaceId: string;
  readonly clerkOrgId: string;
  readonly mode: MailStoreMode;
  private readonly postgresWorkspace: WorkspaceMailStore;
  private readonly objectWorkspace?: WorkspaceMailStore;
  private readonly adminEnv?: MailboxStoreNamespaceEnv;
  private readonly kv?: DriftKv;
  private readonly waitUntilFn: (p: Promise<unknown>) => void;
  private readonly parity?: ParitySampler;
  private readonly now: () => number;
  private readonly mailboxes = new Map<string, RoutedMailboxStore>();

  constructor(deps: RoutedWorkspaceMailStoreDeps) {
    this.workspaceId = deps.workspaceId;
    this.clerkOrgId = deps.clerkOrgId;
    this.mode = deps.mode;
    this.postgresWorkspace = deps.postgresWorkspace;
    this.objectWorkspace = deps.objectWorkspace;
    this.adminEnv = deps.adminEnv;
    this.kv = deps.kv;
    this.waitUntilFn = deps.waitUntil;
    this.now = deps.now ?? Date.now;
    if (this.mode === 'shadow') {
      this.parity = new ParitySampler({
        rate: deps.parityRate ?? 0.05,
        random: deps.parityRandom,
        onMismatch: deps.parityOnMismatch ?? ((mismatch) => this.onParityMismatch(mismatch)),
      });
    }
  }

  private onParityMismatch(mismatch: Parameters<ParityMismatchHandler>[0]): void {
    logParityMismatch(mismatch);
    if (this.kv) {
      this.waitUntilFn(markMailboxDrift(this.kv, mismatch.ref, 'pg-to-object', { kind: `parity:${mismatch.kind}`, ids: [] }));
    }
  }

  mailbox(accountId: string): RoutedMailboxStore {
    let store = this.mailboxes.get(accountId);
    if (!store) {
      const ref: MailboxRef = { workspaceId: this.workspaceId, accountId, clerkOrgId: this.clerkOrgId };
      store = new RoutedMailboxStore({
        ref,
        mode: this.mode,
        postgres: this.postgresWorkspace.mailbox(accountId),
        object: this.objectWorkspace?.mailbox(accountId),
        adminEnv: this.adminEnv,
        kv: this.kv,
        waitUntil: this.waitUntilFn,
        parity: this.parity,
        now: this.now,
      });
      this.mailboxes.set(accountId, store);
    }
    return store;
  }

  private refFor(accountId: string): MailboxRef {
    return { workspaceId: this.workspaceId, accountId, clerkOrgId: this.clerkOrgId };
  }

  /**
   * `object` mode's half of the cross-mailbox readiness check (this file's
   * header comment): every mailbox in `accountIds` must report ready, via the
   * SAME per-isolate cache `RoutedMailboxStore.routedRead` probes for a
   * single mailbox, or the whole read demotes to Postgres.
   */
  private async allMailboxesReady(accountIds: readonly string[]): Promise<boolean> {
    if (!this.adminEnv || accountIds.length === 0) return true;
    const adminEnv = this.adminEnv;
    const now = this.now();
    const checks = await Promise.all(accountIds.map((accountId) => probeReadiness(adminEnv, this.refFor(accountId), now)));
    return checks.every(Boolean);
  }

  /**
   * `object-only` mode's half (this file's header comment): there's no
   * Postgres to demote to, so this only warns — once per isolate per mailbox
   * — that object-only is live before every mailbox finished backfill.
   */
  private async warnIfAnyNotReady(accountIds: readonly string[]): Promise<void> {
    if (!this.adminEnv || accountIds.length === 0) return;
    const adminEnv = this.adminEnv;
    const now = this.now();
    await Promise.all(
      accountIds.map(async (accountId) => {
        const ref = this.refFor(accountId);
        if (!(await probeReadiness(adminEnv, ref, now))) warnObjectOnlyNotReady(ref);
      }),
    );
  }

  /** `postgres`/`shadow` → the Postgres fan-out (as today); `object`/`object-only` → the object's fan-out, gated by the readiness checks this file's header comment describes, falling back wholesale to Postgres on total failure in `object` only. */
  private async crossMailboxRead<T>(accountIds: readonly string[], objectCall: () => Promise<T>, postgresCall: () => Promise<T>): Promise<T> {
    if (this.mode === 'postgres' || this.mode === 'shadow') return postgresCall();

    if (this.mode === 'object') {
      if (!(await this.allMailboxesReady(accountIds))) return postgresCall();
    } else {
      await this.warnIfAnyNotReady(accountIds);
    }

    try {
      return await objectCall();
    } catch (err) {
      if (this.mode === 'object-only') throw err;
      console.error('[mail-store] object workspace read failed, falling back to Postgres:', err instanceof Error ? err.message : err);
      return postgresCall();
    }
  }

  listThreads(accountIds: string[], q: ThreadListQuery): Promise<ThreadPage> {
    return this.crossMailboxRead(accountIds, () => this.objectWorkspace!.listThreads(accountIds, q), () => this.postgresWorkspace.listThreads(accountIds, q));
  }

  listMessages(accountIds: string[], q: MessageListQuery): Promise<MessagePage> {
    return this.crossMailboxRead(accountIds, () => this.objectWorkspace!.listMessages(accountIds, q), () => this.postgresWorkspace.listMessages(accountIds, q));
  }

  stats(accountIds: string[]) {
    return this.crossMailboxRead(accountIds, () => this.objectWorkspace!.stats(accountIds), () => this.postgresWorkspace.stats(accountIds));
  }

  unreadBadge(accountIds: string[]): Promise<number> {
    return this.crossMailboxRead(accountIds, () => this.objectWorkspace!.unreadBadge(accountIds), () => this.postgresWorkspace.unreadBadge(accountIds));
  }

  locateMessages(
    ids: string[],
    accountIds: string[],
    hint?: string,
    opts?: { includeDeleted?: boolean },
  ): Promise<Map<string, string>> {
    return this.crossMailboxRead(
      accountIds,
      () => this.objectWorkspace!.locateMessages(ids, accountIds, hint, opts),
      () => this.postgresWorkspace.locateMessages(ids, accountIds, hint, opts),
    );
  }

  locateAttachment(id: string, accountIds: string[], hint?: string) {
    return this.crossMailboxRead(
      accountIds,
      () => this.objectWorkspace!.locateAttachment(id, accountIds, hint),
      () => this.postgresWorkspace.locateAttachment(id, accountIds, hint),
    );
  }

  locateDraft(id: string, accountIds: string[], hint?: string) {
    return this.crossMailboxRead(
      accountIds,
      () => this.objectWorkspace!.locateDraft(id, accountIds, hint),
      () => this.postgresWorkspace.locateDraft(id, accountIds, hint),
    );
  }

  messagesByCounterparty(address: string, accountIds: string[], q: { cursor?: MessageCursor; limit: number }) {
    return this.crossMailboxRead(
      accountIds,
      () => this.objectWorkspace!.messagesByCounterparty(address, accountIds, q),
      () => this.postgresWorkspace.messagesByCounterparty(address, accountIds, q),
    );
  }

  recentAttachments(accountIds: string[], q: { limit: number }) {
    return this.crossMailboxRead(accountIds, () => this.objectWorkspace!.recentAttachments(accountIds, q), () => this.postgresWorkspace.recentAttachments(accountIds, q));
  }

  recentMessages(accountIds: string[], limit: number): Promise<MailMessageListRow[]> {
    return this.crossMailboxRead(accountIds, () => this.objectWorkspace!.recentMessages(accountIds, limit), () => this.postgresWorkspace.recentMessages(accountIds, limit));
  }

  listSnoozed(accountIds: string[]): Promise<SnoozedMessage[]> {
    return this.crossMailboxRead(accountIds, () => this.objectWorkspace!.listSnoozed(accountIds), () => this.postgresWorkspace.listSnoozed(accountIds));
  }

  listScheduled(accountIds: string[]): Promise<MailMessageRecord[]> {
    return this.crossMailboxRead(accountIds, () => this.objectWorkspace!.listScheduled(accountIds), () => this.postgresWorkspace.listScheduled(accountIds));
  }

  listDrafts(accountIds: string[], q: { limit: number; cursor?: string }) {
    return this.crossMailboxRead(accountIds, () => this.objectWorkspace!.listDrafts(accountIds, q), () => this.postgresWorkspace.listDrafts(accountIds, q));
  }

  /**
   * A cross-mailbox WRITE, so it needs its own dual-write handling rather than
   * `crossMailboxRead`'s pure fan-out:
   * - `postgres`: the one Postgres call, unchanged.
   * - `object-only`: the one object call (`ObjectWorkspaceMailStore` already
   *   loops `mailbox(accountId).apply({kind:'folder.read',...})` internally).
   * - `object`: the object call is primary (awaited); the same scope is
   *   mirrored to Postgres as a secondary, `waitUntil`'d.
   * - `shadow`: Postgres is primary (today's exact call, so no behaviour
   *   change on the primary path); each updated id is then dual-written to
   *   its own mailbox's object as a `flags{isRead:true}` op, chunked by 1000
   *   (design §2.2: "folder.read secondary gets converted to flags... in
   *   chunks of 1000"), via `RoutedMailboxStore.applyToObjectSecondaryOnly`
   *   so it shares the normal secondary-failure handling.
   */
  async markFolderRead(
    accountIds: string[],
    scope: ThreadFilter,
    o?: MarkFolderReadOptions,
  ): Promise<{ updatedCount: number; updated: { id: string; accountId: string }[] }> {
    if (this.mode === 'postgres') return this.postgresWorkspace.markFolderRead(accountIds, scope, o);
    if (this.mode === 'object-only') return this.objectWorkspace!.markFolderRead(accountIds, scope, o);

    if (this.mode === 'object') {
      const result = await this.objectWorkspace!.markFolderRead(accountIds, scope, o);
      this.waitUntilFn(
        this.postgresWorkspace.markFolderRead(accountIds, scope, o).catch((err: unknown) => {
          console.error(
            '[mail-store] mailbox_secondary_write_failed',
            JSON.stringify({ workspaceId: this.workspaceId, accountIds, kind: 'folder.read', direction: 'object-to-pg', error: err instanceof Error ? err.message : String(err) }),
          );
        }),
      );
      return result;
    }

    // shadow
    const result = await this.postgresWorkspace.markFolderRead(accountIds, scope, o);
    const now = this.now();
    const byAccount = new Map<string, string[]>();
    for (const { id, accountId } of result.updated) {
      const ids = byAccount.get(accountId);
      if (ids) ids.push(id);
      else byAccount.set(accountId, [id]);
    }
    for (const [accountId, ids] of byAccount) {
      for (const idsChunk of chunk(ids, 1000)) {
        this.mailbox(accountId).applyToObjectSecondaryOnly(
          [{ kind: 'flags', ids: idsChunk, patch: { isRead: true }, semantics: 'bulk' }],
          now,
        );
      }
    }
    return result;
  }
}
