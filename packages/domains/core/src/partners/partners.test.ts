/**
 * Extra-credit grants (billing row before wallet, retry repair) and the
 * workspace-context cache invalidation. Partner tables are not in pglite, so
 * the db handle is a scripted fake and the credits engine a spy.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as masterSchema from '@weldsuite/db/schema/master';

const credits = vi.hoisted(() => ({ grantCredits: vi.fn() }));
vi.mock('@weldsuite/credits', () => credits);
vi.mock('./licences', async (orig) => ({
  ...(await orig<typeof import('./licences')>()),
  getActiveContract: vi.fn(async () => ({ extraCreditPrice: '0.004' })),
}));

import { grantPartnerExtraCredits, invalidateWorkspaceContexts } from './partners';

interface Op {
  op: 'insert' | 'update' | 'delete';
  table: unknown;
  values?: Record<string, unknown>;
  set?: Record<string, unknown>;
}

/** Records every write in `log` (shared with the credits spy) in call order. */
function fakeDb(opts: { insertReturning: unknown[]; selects?: unknown[][] }, log: string[]) {
  const ops: Op[] = [];
  const selects = [...(opts.selects ?? [])];
  const chain = (result: unknown[], op?: Op): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(result);
          if (prop === 'catch') return () => chain(result, op);
          return (...args: unknown[]) => {
            if (op && prop === 'values') op.values = args[0] as Record<string, unknown>;
            if (op && prop === 'set') op.set = args[0] as Record<string, unknown>;
            return chain(result, op);
          };
        },
      },
    );
  const write = (op: Op['op'], table: unknown, result: unknown[]) => {
    const o: Op = { op, table };
    ops.push(o);
    log.push(`${op}:${table === masterSchema.partnerCreditGrants ? 'grants' : 'other'}`);
    return chain(result, o);
  };
  const db = {
    select: () => chain(selects.shift() ?? []),
    insert: (table: unknown) => write('insert', table, opts.insertReturning),
    update: (table: unknown) => write('update', table, []),
    delete: (table: unknown) => write('delete', table, []),
  };
  return { db, ops };
}

const input = (db: unknown) => ({
  db: db as never,
  partnerId: 'ptr_1',
  workspaceId: 'ws_1',
  credits: 500,
  grantedBy: 'user_1',
  idempotencyKey: 'ptr_1:ws_1:key-1',
});

describe('grantPartnerExtraCredits', () => {
  let log: string[];
  beforeEach(() => {
    log = [];
    credits.grantCredits.mockReset().mockImplementation(async () => {
      log.push('wallet');
      return { ok: true, transactionId: 'ctx_1', newBalance: 700, duplicate: false };
    });
  });

  it('writes the billing row before crediting the wallet, then links the transaction', async () => {
    const { db, ops } = fakeDb({ insertReturning: [{ id: 'x' }], selects: [[{ amount: '2.00' }]] }, log);
    const out = await grantPartnerExtraCredits(input(db));

    expect(log).toEqual(['insert:grants', 'wallet', 'update:grants']);
    const insert = ops.find((o) => o.op === 'insert')!;
    expect(insert.values).toMatchObject({ partnerId: 'ptr_1', workspaceId: 'ws_1', credits: 500, amount: '2.00', creditTransactionId: null });
    expect(String(insert.values!.id)).toMatch(/^pcg_[0-9a-f]{24}$/);
    expect(ops.find((o) => o.op === 'update')!.set).toEqual({ creditTransactionId: 'ctx_1' });
    expect(out).toEqual({ grantId: insert.values!.id, newBalance: 700, amount: '2.00', duplicate: false });
  });

  it('derives the same billing row id for the same key and a different one for another', async () => {
    const ids: string[] = [];
    for (const key of ['ptr_1:ws_1:key-1', 'ptr_1:ws_1:key-1', 'ptr_1:ws_1:key-2']) {
      const { db, ops } = fakeDb({ insertReturning: [{ id: 'x' }], selects: [[{ amount: '2.00' }]] }, []);
      await grantPartnerExtraCredits({ ...input(db), idempotencyKey: key });
      ids.push(String(ops.find((o) => o.op === 'insert')!.values!.id));
    }
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).not.toBe(ids[2]);
  });

  it('removes the billing row again when the wallet grant fails, and rethrows', async () => {
    credits.grantCredits.mockRejectedValue(new Error('db down'));
    const { db } = fakeDb({ insertReturning: [{ id: 'x' }] }, log);
    await expect(grantPartnerExtraCredits(input(db))).rejects.toThrow('db down');
    expect(log).toEqual(['insert:grants', 'delete:grants']);
  });

  it('keeps a billing row an earlier attempt wrote when a retry fails', async () => {
    credits.grantCredits.mockRejectedValue(new Error('db down'));
    const { db } = fakeDb({ insertReturning: [] }, log); // conflict: the row already existed
    await expect(grantPartnerExtraCredits(input(db))).rejects.toThrow('db down');
    expect(log).toEqual(['insert:grants']);
  });

  it('repairs on retry: the row exists unlinked, the wallet grant is new, nothing is billed twice', async () => {
    // First attempt wrote the row and died before the wallet. The retry hits
    // the conflict (no new row), grants, and links the existing row.
    const { db, ops } = fakeDb({ insertReturning: [], selects: [[{ amount: '2.00' }]] }, log);
    const out = await grantPartnerExtraCredits(input(db));
    expect(credits.grantCredits).toHaveBeenCalledTimes(1);
    expect(ops.find((o) => o.op === 'update')!.set).toEqual({ creditTransactionId: 'ctx_1' });
    expect(out).toMatchObject({ amount: '2.00', duplicate: false });
  });

  it('repairs on retry: the wallet was credited but the row is missing, so the row is written now', async () => {
    credits.grantCredits.mockResolvedValue({ ok: true, transactionId: 'ctx_old', newBalance: 700, duplicate: true });
    const { db, ops } = fakeDb({ insertReturning: [{ id: 'x' }], selects: [[{ amount: '2.00' }]] }, log);
    const out = await grantPartnerExtraCredits(input(db));
    expect(ops.filter((o) => o.op === 'insert')).toHaveLength(1);
    expect(ops.find((o) => o.op === 'update')!.set).toEqual({ creditTransactionId: 'ctx_old' });
    expect(out.duplicate).toBe(true);
  });

  it('is a no-op for a fully recorded retry (row linked, wallet duplicate)', async () => {
    credits.grantCredits.mockResolvedValue({ ok: true, transactionId: 'ctx_1', newBalance: 700, duplicate: true });
    const { db } = fakeDb({ insertReturning: [], selects: [[{ amount: '2.00' }]] }, log);
    const out = await grantPartnerExtraCredits(input(db));
    expect(out).toMatchObject({ amount: '2.00', duplicate: true, newBalance: 700 });
  });
});

describe('invalidateWorkspaceContexts', () => {
  const kv = () => ({ delete: vi.fn(async (_key: string) => undefined) });

  it('deletes the worker-kit, external-api and mcp-server keys', async () => {
    const workspaceCache = kv();
    const apiCache = kv();
    await invalidateWorkspaceContexts(workspaceCache, ['org_1', null, 'org_2'], { apiCache, workspaceIds: ['ws_1', 'ws_2'] });
    expect(workspaceCache.delete.mock.calls.map((c) => c[0]).sort()).toEqual(['ws:org_1', 'ws:org_2']);
    expect(apiCache.delete.mock.calls.map((c) => c[0]).sort()).toEqual(['mcp:org:org_1', 'mcp:org:org_2', 'ws:ws_1', 'ws:ws_2']);
  });

  it('also deletes the tenant-database-only keys when asked (database moves)', async () => {
    const workspaceCache = kv();
    const apiCache = kv();
    await invalidateWorkspaceContexts(workspaceCache, ['org_1'], {
      apiCache,
      workspaceIds: ['ws_1'],
      databaseKeys: true,
    });
    expect(workspaceCache.delete.mock.calls.map((c) => c[0]).sort()).toEqual([
      'ws:id:org_1',
      'ws:id:ws_1',
      'ws:org_1',
      'wsid:ws_1',
    ]);
    expect(apiCache.delete.mock.calls.map((c) => c[0]).sort()).toEqual(['mcp:org:org_1', 'ws:ws_1']);
  });

  it('keeps the licence callers as they were: no wsid:/ws:id: keys unless databaseKeys is set', async () => {
    const workspaceCache = kv();
    await invalidateWorkspaceContexts(workspaceCache, ['org_1'], { workspaceIds: ['ws_1'] });
    expect(workspaceCache.delete.mock.calls.map((c) => c[0])).toEqual(['ws:org_1']);
  });

  it('keeps the two-argument behaviour (only ws:<org> in WORKSPACE_CACHE)', async () => {
    const workspaceCache = kv();
    await invalidateWorkspaceContexts(workspaceCache, ['org_1']);
    expect(workspaceCache.delete).toHaveBeenCalledTimes(1);
    expect(workspaceCache.delete).toHaveBeenCalledWith('ws:org_1');
  });

  it('survives a failing delete and a missing handle', async () => {
    const workspaceCache = { delete: vi.fn(async (_key: string): Promise<void> => { throw new Error('kv'); }) };
    const apiCache = kv();
    await expect(invalidateWorkspaceContexts(workspaceCache, ['org_1'], { apiCache, workspaceIds: ['ws_1'] })).resolves.toBeUndefined();
    expect(apiCache.delete).toHaveBeenCalledTimes(2);
    await expect(invalidateWorkspaceContexts(undefined, ['org_1'])).resolves.toBeUndefined();
  });
});
