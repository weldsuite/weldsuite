/**
 * Offline mutation outbox (Phase 2 of offline support).
 *
 * A persisted, org-scoped queue of mailbox mutations (mark read/star/spam,
 * delete, archive, snooze). Mutations apply optimistically in the UI, get
 * enqueued here, and flush to the network when connectivity allows. Offline
 * actions therefore survive app restarts and replay automatically on reconnect.
 *
 * The engine is pure (no React, no appApi) so it can be unit-tested directly —
 * the network side is injected into {@link flushOutbox} as a runner, and the
 * appApi-backed runner lives in ./flush.ts.
 *
 * Collapse rules keep the queue minimal and convergent: repeated flag toggles
 * merge into one update, a delete supersedes everything for that message, and
 * the latest snooze/unsnooze wins. Without this a star→unstar→star dance would
 * replay three redundant requests.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SendMailMessageInput } from '@weldsuite/app-api-client';

const PREFIX = 'weldmail.outbox';
/** Bump to discard any queue written under an older op shape. */
const VERSION = 1;
/** Drop an op after this many failed flush cycles so the queue can't wedge. */
export const MAX_ATTEMPTS = 6;

/** Boolean message flags that can be optimistically toggled. */
export type MessagePatch = Partial<
  Record<'isRead' | 'isStarred' | 'isSpam' | 'isImportant' | 'isFlagged', boolean>
>;

/**
 * Every op may record whether it targets the personal tenant, captured when it
 * is queued. The runner can't reliably work that out at replay time: the
 * personal account/message id registry is in memory and is empty on a cold
 * start until the account list loads, so a replayed personal op went to
 * app-api, got a 404 and was dropped. Absent on ops queued by older builds.
 */
type OpBase = { id: string; attempts: number; createdAt: number; personal?: boolean };

export type OutboxOp =
  | (OpBase & { kind: 'update'; messageId: string; patch: MessagePatch })
  | (OpBase & { kind: 'delete'; messageId: string })
  | (OpBase & { kind: 'archive'; messageId: string })
  | (OpBase & { kind: 'snooze'; messageId: string; accountId: string; until: string })
  | (OpBase & { kind: 'unsnooze'; messageId: string; accountId: string })
  // A composed message queued for send. `payload.idempotencyKey` makes replay
  // safe — the backend returns the already-sent message if the key was seen.
  | (OpBase & { kind: 'send'; accountId: string; payload: SendMailMessageInput });

function key(orgId: string): string {
  return `${PREFIX}.${VERSION}.${orgId}`;
}

export async function loadOutbox(orgId: string): Promise<OutboxOp[]> {
  try {
    const raw = await AsyncStorage.getItem(key(orgId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as OutboxOp[]) : [];
  } catch {
    return [];
  }
}

export async function saveOutbox(orgId: string, ops: OutboxOp[]): Promise<void> {
  try {
    await AsyncStorage.setItem(key(orgId), JSON.stringify(ops));
  } catch {
    // best-effort
  }
}

/**
 * Forget every queued op for an org. Called on sign-out so a different user
 * signing in on the same device never replays the previous user's queued
 * mutations (or sends) under their own session.
 */
export async function clearOutbox(orgId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key(orgId));
  } catch {
    // best-effort
  }
}

/**
 * Fold a new op into the existing queue, applying convergence rules so the
 * queue stays minimal. Pure — returns the next queue, never mutates the input.
 */
export function collapse(ops: OutboxOp[], incoming: OutboxOp): OutboxOp[] {
  // Sends are never merged — each composed message is a distinct intent.
  if (incoming.kind === 'send') return [...ops, incoming];
  const sameMsg = (o: OutboxOp) => o.kind !== 'send' && o.messageId === incoming.messageId;

  // A delete makes every other queued op for that message moot.
  if (incoming.kind === 'delete') {
    return [...ops.filter((o) => !sameMsg(o)), incoming];
  }
  // Once a delete is queued, nothing else about that message matters.
  if (ops.some((o) => sameMsg(o) && o.kind === 'delete')) {
    return ops;
  }

  if (incoming.kind === 'update') {
    // Merge flag changes into the pending update; reset attempts so the merged
    // intent gets a fresh retry budget.
    const existing = ops.find((o) => sameMsg(o) && o.kind === 'update') as
      | Extract<OutboxOp, { kind: 'update' }>
      | undefined;
    if (existing) {
      const merged: OutboxOp = { ...existing, patch: { ...existing.patch, ...incoming.patch }, attempts: 0 };
      return ops.map((o) => (o === existing ? merged : o));
    }
    return [...ops, incoming];
  }

  if (incoming.kind === 'archive') {
    if (ops.some((o) => sameMsg(o) && o.kind === 'archive')) return ops; // dedupe
    return [...ops, incoming];
  }

  // snooze / unsnooze: only the latest state matters.
  if (incoming.kind === 'snooze' || incoming.kind === 'unsnooze') {
    return [
      ...ops.filter((o) => !(sameMsg(o) && (o.kind === 'snooze' || o.kind === 'unsnooze'))),
      incoming,
    ];
  }

  return [...ops, incoming];
}

// Per-org promise chain serialising every read-modify-write of a queue. Without
// it two quick enqueues (load, load, save, save) or an enqueue landing while a
// flush is mid-network would each overwrite the other's write and lose an op.
const locks = new Map<string, Promise<unknown>>();

function withOutboxLock<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(orgId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(orgId, next.catch(() => undefined));
  return next;
}

export async function enqueueOp(orgId: string, op: OutboxOp): Promise<OutboxOp[]> {
  return withOutboxLock(orgId, async () => {
    const ops = await loadOutbox(orgId);
    const next = collapse(ops, op);
    await saveOutbox(orgId, next);
    return next;
  });
}

/**
 * Overlay pending ops onto a fetched/cached message list so the UI reflects
 * not-yet-synced changes. Patches flags, and hides messages that a pending op
 * has moved out of the current view (deleted everywhere; archived outside
 * ARCHIVE; snoozed outside SNOOZED). Pure.
 */
export function applyOps<T extends { id: string }>(messages: T[], ops: OutboxOp[], label?: string): T[] {
  if (!ops.length) return messages;
  const byMsg = new Map<string, OutboxOp[]>();
  for (const op of ops) {
    if (op.kind === 'send') continue; // sends don't target an existing list row
    const arr = byMsg.get(op.messageId) ?? [];
    arr.push(op);
    byMsg.set(op.messageId, arr);
  }
  const upper = (label ?? '').toUpperCase();
  const result: T[] = [];
  for (const m of messages) {
    const mops = byMsg.get(m.id);
    if (!mops) {
      result.push(m);
      continue;
    }
    if (mops.some((o) => o.kind === 'delete')) continue;
    if (mops.some((o) => o.kind === 'archive') && upper !== 'ARCHIVE') continue;
    if (mops.some((o) => o.kind === 'snooze') && upper !== 'SNOOZED') continue;
    if (mops.some((o) => o.kind === 'unsnooze') && upper === 'SNOOZED') continue;
    let patched = m;
    for (const o of mops) {
      if (o.kind === 'update') patched = { ...patched, ...o.patch };
    }
    result.push(patched);
  }
  return result;
}

export interface FlushResult {
  remaining: number;
  succeeded: number;
  dropped: number;
}

/**
 * Whether a flush changed server-side state in a way the UI should reconcile to.
 * True when ops actually synced (`succeeded`) or were dropped as conflicts
 * (`dropped`, i.e. the server rejected them — server-wins). A no-op flush
 * (nothing queued, or everything still pending behind an offline wall) returns
 * false so we don't churn needless refetches.
 */
export function shouldReconcileAfterFlush(result: FlushResult | null): boolean {
  if (!result) return false;
  return result.succeeded > 0 || result.dropped > 0;
}

export type OpRunner = (op: OutboxOp) => Promise<void>;

/**
 * Replay the queue through `run`, removing ops that succeed. On a network error
 * the current op (and everything after it) is kept for the next flush and the
 * pass stops — there's no point hammering a dead connection. Network failures
 * don't count against an op's retry budget: being offline is not the op's fault,
 * and counting them let a queued send be dropped just because the user touched
 * a few messages while offline (each touch kicks a flush).
 *
 * A server error that `isTransient` recognises (5xx, rate limit, an expired
 * session on resume) keeps the op and spends one attempt. Any other server error
 * means the request was rejected, so the op is dropped rather than retried
 * forever. Ops that exhaust MAX_ATTEMPTS are also dropped so a permanently
 * failing op can't wedge the queue.
 *
 * The network calls run outside the queue lock, so ops can be enqueued while a
 * flush is in progress. The result is therefore merged back into the *current*
 * queue: only the ops this pass handled (matched by id and unchanged content, so
 * an update that was merged mid-flight re-runs with its new patch) are removed.
 */
export async function flushOutbox(
  orgId: string,
  run: OpRunner,
  isNetErr: (e: unknown) => boolean,
  isTransient: (e: unknown) => boolean = () => false,
): Promise<FlushResult> {
  const ops = await loadOutbox(orgId);
  if (!ops.length) return { remaining: 0, succeeded: 0, dropped: 0 };

  const handled = new Set<string>();
  const retried = new Map<string, OutboxOp>();
  let succeeded = 0;
  let dropped = 0;

  for (const op of ops) {
    if (op.attempts >= MAX_ATTEMPTS) {
      handled.add(JSON.stringify(op));
      dropped++;
      continue;
    }
    try {
      await run(op);
      handled.add(JSON.stringify(op));
      succeeded++;
    } catch (e) {
      // Offline mid-flush: keep this op and all the ones after it, stop.
      if (isNetErr(e)) break;
      if (isTransient(e)) {
        retried.set(JSON.stringify(op), { ...op, attempts: op.attempts + 1 });
        continue;
      }
      handled.add(JSON.stringify(op));
      dropped++; // server rejected — don't retry
    }
  }

  return withOutboxLock(orgId, async () => {
    const current = await loadOutbox(orgId);
    const next: OutboxOp[] = [];
    for (const op of current) {
      const sig = JSON.stringify(op);
      if (handled.has(sig)) continue;
      next.push(retried.get(sig) ?? op);
    }
    await saveOutbox(orgId, next);
    return { remaining: next.length, succeeded, dropped };
  });
}
