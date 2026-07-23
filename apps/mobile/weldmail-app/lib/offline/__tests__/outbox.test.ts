/**
 * Unit tests for the offline mutation outbox engine — persistence, collapse
 * rules, the pending-ops overlay, and flush retry semantics. Uses a real
 * in-memory AsyncStorage mock so enqueue/flush round-trip through storage.
 */

const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn((k: string) => Promise.resolve(mockStore.has(k) ? mockStore.get(k)! : null)),
  setItem: jest.fn((k: string, v: string) => {
    mockStore.set(k, v);
    return Promise.resolve();
  }),
}));

import {
  loadOutbox,
  saveOutbox,
  enqueueOp,
  collapse,
  applyOps,
  flushOutbox,
  shouldReconcileAfterFlush,
  MAX_ATTEMPTS,
  type OutboxOp,
} from '../outbox';

const ORG = 'org_1';
let seq = 0;
const update = (messageId: string, patch: OutboxOp extends { kind: 'update' } ? never : any): OutboxOp => ({
  id: `op_${seq++}`,
  kind: 'update',
  messageId,
  patch,
  attempts: 0,
  createdAt: seq,
});
const del = (messageId: string): OutboxOp => ({ id: `op_${seq++}`, kind: 'delete', messageId, attempts: 0, createdAt: seq });
const archive = (messageId: string): OutboxOp => ({ id: `op_${seq++}`, kind: 'archive', messageId, attempts: 0, createdAt: seq });
const snooze = (messageId: string, until = '2026-07-01'): OutboxOp => ({ id: `op_${seq++}`, kind: 'snooze', messageId, accountId: 'acc_1', until, attempts: 0, createdAt: seq });
const unsnooze = (messageId: string): OutboxOp => ({ id: `op_${seq++}`, kind: 'unsnooze', messageId, accountId: 'acc_1', attempts: 0, createdAt: seq });
const send = (key: string): OutboxOp => ({ id: `op_${seq++}`, kind: 'send', accountId: 'acc_1', payload: { to: ['a@b.com'], idempotencyKey: key } as any, attempts: 0, createdAt: seq });

beforeEach(() => {
  mockStore.clear();
  seq = 0;
});

describe('persistence', () => {
  it('starts empty and round-trips enqueued ops', async () => {
    expect(await loadOutbox(ORG)).toEqual([]);
    await enqueueOp(ORG, update('m1', { isStarred: true }));
    const ops = await loadOutbox(ORG);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: 'update', messageId: 'm1', patch: { isStarred: true } });
  });

  it('scopes the queue by org', async () => {
    await enqueueOp(ORG, update('m1', { isRead: true }));
    expect(await loadOutbox('org_2')).toEqual([]);
  });
});

describe('collapse', () => {
  it('merges repeated flag updates for the same message into one op', () => {
    let ops: OutboxOp[] = [];
    ops = collapse(ops, update('m1', { isStarred: true }));
    ops = collapse(ops, update('m1', { isRead: true }));
    ops = collapse(ops, update('m1', { isStarred: false }));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: 'update', patch: { isStarred: false, isRead: true } });
  });

  it('keeps updates for different messages separate', () => {
    let ops: OutboxOp[] = [];
    ops = collapse(ops, update('m1', { isStarred: true }));
    ops = collapse(ops, update('m2', { isStarred: true }));
    expect(ops).toHaveLength(2);
  });

  it('delete supersedes all prior ops for the message', () => {
    let ops: OutboxOp[] = [];
    ops = collapse(ops, update('m1', { isStarred: true }));
    ops = collapse(ops, archive('m1'));
    ops = collapse(ops, del('m1'));
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe('delete');
  });

  it('ignores further ops once a delete is queued', () => {
    let ops: OutboxOp[] = [del('m1')];
    ops = collapse(ops, update('m1', { isStarred: true }));
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe('delete');
  });

  it('dedupes archive', () => {
    let ops: OutboxOp[] = [];
    ops = collapse(ops, archive('m1'));
    ops = collapse(ops, archive('m1'));
    expect(ops.filter((o) => o.kind === 'archive')).toHaveLength(1);
  });

  it('keeps only the latest snooze/unsnooze for a message', () => {
    let ops: OutboxOp[] = [];
    ops = collapse(ops, snooze('m1', '2026-07-01'));
    ops = collapse(ops, unsnooze('m1'));
    ops = collapse(ops, snooze('m1', '2026-08-01'));
    const snoozeOps = ops.filter((o) => o.kind === 'snooze' || o.kind === 'unsnooze');
    expect(snoozeOps).toHaveLength(1);
    expect(snoozeOps[0]).toMatchObject({ kind: 'snooze', until: '2026-08-01' });
  });

  it('never merges send ops — each composed message is distinct', () => {
    let ops: OutboxOp[] = [];
    ops = collapse(ops, send('k1'));
    ops = collapse(ops, send('k2'));
    expect(ops.filter((o) => o.kind === 'send')).toHaveLength(2);
  });

  it('does not let a message op disturb a queued send (no messageId collision)', () => {
    let ops: OutboxOp[] = [send('k1')];
    ops = collapse(ops, del('m1'));
    expect(ops).toHaveLength(2);
    expect(ops.some((o) => o.kind === 'send')).toBe(true);
  });
});

describe('applyOps overlay', () => {
  const msgs = [
    { id: 'm1', isStarred: false, isRead: false },
    { id: 'm2', isStarred: false, isRead: false },
    { id: 'm3', isStarred: false, isRead: false },
  ];

  it('returns the list unchanged when there are no ops', () => {
    expect(applyOps(msgs, [])).toBe(msgs);
  });

  it('ignores send ops (they target no existing list row)', () => {
    expect(applyOps(msgs, [send('k1')], 'INBOX').map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('patches flags from pending updates', () => {
    const out = applyOps(msgs, [update('m1', { isStarred: true, isRead: true })], 'INBOX');
    expect(out.find((m) => m.id === 'm1')).toMatchObject({ isStarred: true, isRead: true });
    expect(out.find((m) => m.id === 'm2')).toMatchObject({ isStarred: false });
  });

  it('hides deleted messages from every view', () => {
    const out = applyOps(msgs, [del('m2')], 'INBOX');
    expect(out.map((m) => m.id)).toEqual(['m1', 'm3']);
  });

  it('hides archived messages from INBOX but not from ARCHIVE', () => {
    expect(applyOps(msgs, [archive('m1')], 'INBOX').map((m) => m.id)).toEqual(['m2', 'm3']);
    expect(applyOps(msgs, [archive('m1')], 'ARCHIVE').map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('hides snoozed messages from INBOX but keeps them in SNOOZED', () => {
    expect(applyOps(msgs, [snooze('m3')], 'INBOX').map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(applyOps(msgs, [snooze('m3')], 'SNOOZED').map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });
});

describe('flushOutbox', () => {
  const ok = () => Promise.resolve();
  const netErr = () => Promise.reject(new (class extends Error { isNetworkError = true })());
  const serverErr = () => Promise.reject(new Error('400 bad request'));
  const isNet = (e: unknown) => typeof e === 'object' && e !== null && (e as any).isNetworkError === true;

  it('runs and clears all ops on success', async () => {
    await enqueueOp(ORG, update('m1', { isRead: true }));
    await enqueueOp(ORG, del('m2'));
    const run = jest.fn(ok);
    const res = await flushOutbox(ORG, run, isNet);
    expect(run).toHaveBeenCalledTimes(2);
    expect(res).toMatchObject({ succeeded: 2, remaining: 0, dropped: 0 });
    expect(await loadOutbox(ORG)).toEqual([]);
  });

  it('keeps the queue and stops on a network error', async () => {
    await enqueueOp(ORG, update('m1', { isRead: true }));
    await enqueueOp(ORG, update('m2', { isRead: true }));
    const run = jest.fn(netErr);
    const res = await flushOutbox(ORG, run, isNet);
    // Stops at the first op; the second is never attempted.
    expect(run).toHaveBeenCalledTimes(1);
    expect(res.remaining).toBe(2);
    const remaining = await loadOutbox(ORG);
    expect(remaining).toHaveLength(2);
    expect(remaining[0].attempts).toBe(1); // incremented for retry
  });

  it('drops an op the server rejects and continues', async () => {
    await enqueueOp(ORG, update('m1', { isRead: true }));
    await enqueueOp(ORG, update('m2', { isRead: true }));
    const run = jest.fn().mockImplementationOnce(serverErr).mockImplementationOnce(ok);
    const res = await flushOutbox(ORG, run, isNet);
    expect(res).toMatchObject({ dropped: 1, succeeded: 1, remaining: 0 });
    expect(await loadOutbox(ORG)).toEqual([]);
  });

  it('drops ops that exhaust MAX_ATTEMPTS', async () => {
    const worn: OutboxOp = { id: 'op_x', kind: 'update', messageId: 'm1', patch: { isRead: true }, attempts: MAX_ATTEMPTS, createdAt: 1 };
    await saveOutbox(ORG, [worn]);
    const run = jest.fn(ok);
    const res = await flushOutbox(ORG, run, isNet);
    expect(run).not.toHaveBeenCalled();
    expect(res.dropped).toBe(1);
    expect(await loadOutbox(ORG)).toEqual([]);
  });
});

describe('shouldReconcileAfterFlush', () => {
  it('is false for a null result or a pure no-op flush', () => {
    expect(shouldReconcileAfterFlush(null)).toBe(false);
    expect(shouldReconcileAfterFlush({ remaining: 0, succeeded: 0, dropped: 0 })).toBe(false);
    // Still offline, everything kept for retry → nothing changed server-side.
    expect(shouldReconcileAfterFlush({ remaining: 3, succeeded: 0, dropped: 0 })).toBe(false);
  });

  it('is true when ops synced or were dropped as conflicts', () => {
    expect(shouldReconcileAfterFlush({ remaining: 0, succeeded: 2, dropped: 0 })).toBe(true);
    expect(shouldReconcileAfterFlush({ remaining: 1, succeeded: 0, dropped: 1 })).toBe(true);
  });
});
