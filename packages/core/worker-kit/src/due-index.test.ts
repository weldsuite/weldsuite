import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  listDueWorkspaces,
  markWorkspaceDue,
  runDueIndexSweep,
  settleWorkspaceDue,
} from './due-index';
import { createMemoryKv, createSqliteD1 } from './testing/d1';

const MIGRATION = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../apps/workers/workflow-worker/migrations/d1/0004_workspace_due_index.sql',
  ),
  'utf8',
);

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);

function setup() {
  return { d1: createSqliteD1(MIGRATION), kv: createMemoryKv() };
}

async function dueAt(d1: D1Database, kind: string, workspaceId: string) {
  return d1
    .prepare('SELECT next_due_at FROM workspace_due_index WHERE kind = ? AND workspace_id = ?')
    .bind(kind, workspaceId)
    .first<number>('next_due_at');
}

describe('markWorkspaceDue', () => {
  it('creates the row, then only ever pulls the due time earlier', async () => {
    const { d1 } = setup();
    await markWorkspaceDue(d1, 'mail_snooze', 'org_a', T0 + 2 * HOUR);
    expect(await dueAt(d1, 'mail_snooze', 'org_a')).toBe(T0 + 2 * HOUR);

    await markWorkspaceDue(d1, 'mail_snooze', 'org_a', T0 + 5 * HOUR);
    expect(await dueAt(d1, 'mail_snooze', 'org_a')).toBe(T0 + 2 * HOUR);

    await markWorkspaceDue(d1, 'mail_snooze', 'org_a', T0 + HOUR);
    expect(await dueAt(d1, 'mail_snooze', 'org_a')).toBe(T0 + HOUR);
  });

  it('keeps kinds apart', async () => {
    const { d1 } = setup();
    await markWorkspaceDue(d1, 'mail_snooze', 'org_a', T0);
    await markWorkspaceDue(d1, 'domain_renew', 'org_a', T0 + HOUR);
    expect(await dueAt(d1, 'mail_snooze', 'org_a')).toBe(T0);
    expect(await dueAt(d1, 'domain_renew', 'org_a')).toBe(T0 + HOUR);
  });

  it('is a no-op without a binding or workspace, and never throws on D1 errors', async () => {
    await expect(markWorkspaceDue(undefined, 'mail_snooze', 'org_a')).resolves.toBeUndefined();
    const { d1 } = setup();
    await markWorkspaceDue(d1, 'mail_snooze', undefined);
    expect(await d1.prepare('SELECT COUNT(*) AS n FROM workspace_due_index').first<number>('n')).toBe(0);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = createSqliteD1(); // no table
    await expect(markWorkspaceDue(broken, 'mail_snooze', 'org_a')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('listDueWorkspaces', () => {
  it('lists only due rows of the kind, earliest first, up to the limit', async () => {
    const { d1 } = setup();
    await markWorkspaceDue(d1, 'mail_snooze', 'org_late', T0 - HOUR);
    await markWorkspaceDue(d1, 'mail_snooze', 'org_early', T0 - 2 * HOUR);
    await markWorkspaceDue(d1, 'mail_snooze', 'org_future', T0 + HOUR);
    await markWorkspaceDue(d1, 'calendar_replan', 'org_other', T0 - HOUR);

    const rows = await listDueWorkspaces(d1, 'mail_snooze', T0, 10);
    expect(rows.map((r) => r.workspaceId)).toEqual(['org_early', 'org_late']);
    expect(await listDueWorkspaces(d1, 'mail_snooze', T0, 1)).toHaveLength(1);
  });
});

describe('settleWorkspaceDue', () => {
  it('stores the re-derived time, or drops the row for null', async () => {
    const { d1 } = setup();
    await markWorkspaceDue(d1, 'mail_snooze', 'org_a', T0);
    await markWorkspaceDue(d1, 'mail_snooze', 'org_b', T0);
    const [a, b] = await listDueWorkspaces(d1, 'mail_snooze', T0, 10);

    expect(await settleWorkspaceDue(d1, 'mail_snooze', a, T0 + 3 * HOUR)).toBe(true);
    expect(await dueAt(d1, 'mail_snooze', a.workspaceId)).toBe(T0 + 3 * HOUR);

    expect(await settleWorkspaceDue(d1, 'mail_snooze', b, null)).toBe(true);
    expect(await dueAt(d1, 'mail_snooze', b.workspaceId)).toBeNull();
  });

  it('never overwrites a write that landed after the row was listed', async () => {
    const { d1 } = setup();
    await markWorkspaceDue(d1, 'mail_snooze', 'org_a', T0);
    const [row] = await listDueWorkspaces(d1, 'mail_snooze', T0, 10);

    // A user snoozes another mail while the sweep is processing this tenant.
    await markWorkspaceDue(d1, 'mail_snooze', 'org_a', T0 + HOUR);

    // The sweep derived "nothing left" before that snooze committed.
    expect(await settleWorkspaceDue(d1, 'mail_snooze', row, null)).toBe(false);
    expect(await settleWorkspaceDue(d1, 'mail_snooze', row, T0 + 9 * HOUR)).toBe(false);
    // Still due, so the next tick re-derives it with the new snooze included.
    expect(await dueAt(d1, 'mail_snooze', 'org_a')).toBe(T0);
  });
});

describe('runDueIndexSweep', () => {
  it('seeds once, then opens only due workspaces and stores when each is next due', async () => {
    const { d1, kv } = setup();
    const listWorkspaces = vi.fn(async () => ['org_a', 'org_b']);
    const processed: string[] = [];
    const process = vi.fn(async (workspaceId: string) => {
      processed.push(workspaceId);
      return workspaceId === 'org_a' ? T0 + 6 * HOUR : null;
    });
    const opts = { d1, kv, kind: 'mail_snooze' as const, label: '[Test]', seed: { key: 'seed:v1', listWorkspaces }, process };

    const first = await runDueIndexSweep({ ...opts, now: T0 });
    expect(first).toEqual({ due: 2, processed: 2, failed: 0, seeded: 2 });
    expect(processed.sort()).toEqual(['org_a', 'org_b']);
    expect(await dueAt(d1, 'mail_snooze', 'org_a')).toBe(T0 + 6 * HOUR);
    expect(await dueAt(d1, 'mail_snooze', 'org_b')).toBeNull();

    // Quiet tick: nothing due, no seed again, no tenant opened.
    processed.length = 0;
    const quiet = await runDueIndexSweep({ ...opts, now: T0 + HOUR });
    expect(quiet).toEqual({ due: 0, processed: 0, failed: 0, seeded: 0 });
    expect(listWorkspaces).toHaveBeenCalledTimes(1);
    expect(processed).toEqual([]);

    // org_a comes due again; org_b stays untouched.
    await runDueIndexSweep({ ...opts, now: T0 + 6 * HOUR });
    expect(processed).toEqual(['org_a']);
  });

  it('keeps a failed workspace due (or backs it off) and carries on with the rest', async () => {
    const { d1, kv } = setup();
    kv.store.set('seed:v1', 'done');
    await markWorkspaceDue(d1, 'calendar_replan', 'org_bad', T0 - 2);
    await markWorkspaceDue(d1, 'calendar_replan', 'org_ok', T0 - 1);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const process = async (workspaceId: string) => {
      if (workspaceId === 'org_bad') throw new Error('neon down');
      return null;
    };
    const base = { d1, kv, kind: 'calendar_replan' as const, label: '[Test]', seed: { key: 'seed:v1', listWorkspaces: async () => [] }, process };

    const res = await runDueIndexSweep({ ...base, now: T0 });
    expect(res).toMatchObject({ due: 2, processed: 1, failed: 1 });
    expect(await dueAt(d1, 'calendar_replan', 'org_bad')).toBe(T0 - 2);
    expect(await dueAt(d1, 'calendar_replan', 'org_ok')).toBeNull();

    await runDueIndexSweep({ ...base, now: T0, retryAfterMs: HOUR });
    expect(await dueAt(d1, 'calendar_replan', 'org_bad')).toBe(T0 + HOUR);
    error.mockRestore();
  });

  it('stops when shouldStop says so, leaving the rest due', async () => {
    const { d1, kv } = setup();
    kv.store.set('seed:v1', 'done');
    for (const id of ['org_1', 'org_2', 'org_3']) await markWorkspaceDue(d1, 'domain_renew', id, T0);
    let handled = 0;
    const res = await runDueIndexSweep({
      d1,
      kv,
      kind: 'domain_renew',
      label: '[Test]',
      seed: { key: 'seed:v1', listWorkspaces: async () => [] },
      process: async () => {
        handled += 1;
        return null;
      },
      shouldStop: () => handled >= 2,
      now: T0,
    });
    expect(res).toMatchObject({ due: 3, processed: 2 });
    expect(await listDueWorkspaces(d1, 'domain_renew', T0, 10)).toHaveLength(1);
  });

  it('never falls back to a fan-out when D1 is missing or failing', async () => {
    const kv = createMemoryKv();
    kv.store.set('seed:v1', 'done');
    const process = vi.fn(async () => null);
    const seed = { key: 'seed:v1', listWorkspaces: vi.fn(async () => ['org_a']) };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runDueIndexSweep({ d1: undefined, kv, kind: 'mail_snooze', label: '[Test]', seed, process });
    await runDueIndexSweep({ d1: createSqliteD1(), kv, kind: 'mail_snooze', label: '[Test]', seed, process });

    expect(process).not.toHaveBeenCalled();
    expect(seed.listWorkspaces).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });

  it('retries the seed next tick when it fails, without setting the flag', async () => {
    const { d1, kv } = setup();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const listWorkspaces = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error('master down'))
      .mockResolvedValueOnce(['org_a']);
    const opts = { d1, kv, kind: 'mail_snooze' as const, label: '[Test]', seed: { key: 'seed:v1', listWorkspaces }, process: async () => null, now: T0 };

    expect(await runDueIndexSweep(opts)).toMatchObject({ seeded: 0, due: 0 });
    expect(kv.store.has('seed:v1')).toBe(false);
    expect(await runDueIndexSweep(opts)).toMatchObject({ seeded: 1, due: 1, processed: 1 });
    expect(kv.store.has('seed:v1')).toBe(true);
    error.mockRestore();
  });
});
