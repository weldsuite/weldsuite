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

export type OutboxOp =
  | { id: string; kind: 'update'; messageId: string; patch: MessagePatch; attempts: number; createdAt: number }
  | { id: string; kind: 'delete'; messageId: string; attempts: number; createdAt: number }
  | { id: string; kind: 'archive'; messageId: string; attempts: number; createdAt: number }
  | { id: string; kind: 'snooze'; messageId: string; accountId: string; until: string; attempts: number; createdAt: number }
  | { id: string; kind: 'unsnooze'; messageId: string; accountId: string; attempts: number; createdAt: number }
  // A composed message queued for send. `payload.idempotencyKey` makes replay
  // safe — the backend returns the already-sent message if the key was seen.
  | { id: string; kind: 'send'; accountId: string; payload: SendMailMessageInput; attempts: number; createdAt: number };

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

export async function enqueueOp(orgId: string, op: OutboxOp): Promise<OutboxOp[]> {
  const ops = await loadOutbox(orgId);
  const next = collapse(ops, op);
  await saveOutbox(orgId, next);
  return next;
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
 * pass stops — there's no point hammering a dead connection. A non-network
 * (server) error means the request reached the server and was rejected, so the
 * op is dropped rather than retried forever. Ops that exhaust MAX_ATTEMPTS are
 * also dropped so a permanently-failing op can't wedge the queue.
 */
export async function flushOutbox(orgId: string, run: OpRunner, isNetErr: (e: unknown) => boolean): Promise<FlushResult> {
  const ops = await loadOutbox(orgId);
  if (!ops.length) return { remaining: 0, succeeded: 0, dropped: 0 };

  const keep: OutboxOp[] = [];
  let succeeded = 0;
  let dropped = 0;

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.attempts >= MAX_ATTEMPTS) {
      dropped++;
      continue;
    }
    try {
      await run(op);
      succeeded++;
    } catch (e) {
      if (isNetErr(e)) {
        // Offline mid-flush: preserve this op and all the ones after it, stop.
        keep.push({ ...op, attempts: op.attempts + 1 }, ...ops.slice(i + 1));
        await saveOutbox(orgId, keep);
        return { remaining: keep.length, succeeded, dropped };
      }
      dropped++; // server rejected — don't retry
    }
  }

  await saveOutbox(orgId, keep);
  return { remaining: keep.length, succeeded, dropped };
}
