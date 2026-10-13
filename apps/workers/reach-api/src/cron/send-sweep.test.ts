import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import { createMemoryKv, createSqliteD1 } from '@weldsuite/worker-kit/testing/d1';
import type { ReachSendMessage } from '../types';
import { queueSpy } from '../test-support/reach';

// The sweep must never reach a tenant (or the master) database: any attempt fails the test.
const dbAccess = vi.hoisted(() => ({ opened: vi.fn() }));
vi.mock('@weldsuite/worker-kit/db', () => ({
  getTenantDbForWorkspace: (...args: unknown[]) => {
    dbAccess.opened(...args);
    throw new Error('the sweep opened a tenant database');
  },
  getMasterDb: (...args: unknown[]) => {
    dbAccess.opened(...args);
    throw new Error('the sweep opened the master database');
  },
  getWorkspaceContextForOrg: (...args: unknown[]) => {
    dbAccess.opened(...args);
    throw new Error('the sweep opened a workspace context');
  },
  schema: {},
  masterSchema: {},
}));

import { PROVISIONAL_NEXT_DUE_MS, readSendDueRow, runSendSweep, settleSendDue } from './send-sweep';
import type { Env } from '../types';

const MIGRATION = readFileSync(resolve(__dirname, '../../../workflow-worker/migrations/d1/0004_workspace_due_index.sql'), 'utf8');

const T0 = Date.UTC(2026, 9, 12, 10, 0, 0);
const MINUTE = 60_000;

function setup() {
  const d1 = createSqliteD1(MIGRATION);
  const queue = queueSpy<ReachSendMessage>();
  const env = { SCHEDULE_INDEX: d1, WORKSPACE_CACHE: createMemoryKv(), REACH_SEND_QUEUE: queue } as unknown as Env;
  return { d1, queue, env };
}

const dueAt = (d1: D1Database, org: string) =>
  d1
    .prepare("SELECT next_due_at FROM workspace_due_index WHERE kind = 'reach_send' AND workspace_id = ?")
    .bind(org)
    .first<number>('next_due_at');

describe('runSendSweep', () => {
  it('enqueues one message per due workspace, from the D1 index alone', async () => {
    const { d1, queue, env } = setup();
    await markWorkspaceDue(d1, 'reach_send', 'org_a', T0 - MINUTE);
    await markWorkspaceDue(d1, 'reach_send', 'org_b', T0 + 30 * MINUTE);
    await markWorkspaceDue(d1, 'reach_send', 'org_c', T0);
    // another kind's due row is not ours to send
    await markWorkspaceDue(d1, 'mail_snooze', 'org_d', T0 - MINUTE);

    const result = await runSendSweep(env, new Date(T0));

    expect(result).toMatchObject({ due: 2, processed: 2, failed: 0 });
    expect(queue.sent.map((m) => m.clerkOrgId).sort()).toEqual(['org_a', 'org_c']);
    expect(queue.sent.every((m) => m.enqueuedAt === T0)).toBe(true);
    expect(dbAccess.opened).not.toHaveBeenCalled();
  });

  it('stores a provisional next due time until the consumer reports the real one', async () => {
    const { d1, queue, env } = setup();
    await markWorkspaceDue(d1, 'reach_send', 'org_a', T0 - MINUTE);
    await runSendSweep(env, new Date(T0));
    expect(await dueAt(d1, 'org_a')).toBe(T0 + PROVISIONAL_NEXT_DUE_MS);
    // not due again on the next tick
    await runSendSweep(env, new Date(T0 + MINUTE));
    expect(queue.sent).toHaveLength(1);
  });

  it('does nothing on a quiet tick', async () => {
    const { queue, env } = setup();
    expect(await runSendSweep(env, new Date(T0))).toMatchObject({ due: 0, processed: 0 });
    expect(queue.sent).toEqual([]);
    expect(dbAccess.opened).not.toHaveBeenCalled();
  });

  it('logs and skips when the queue binding is missing', async () => {
    const { d1 } = setup();
    await markWorkspaceDue(d1, 'reach_send', 'org_a', T0 - MINUTE);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await runSendSweep({ SCHEDULE_INDEX: d1, WORKSPACE_CACHE: createMemoryKv() } as unknown as Env, new Date(T0));
    expect(result).toEqual({ due: 0, processed: 0, failed: 0, seeded: 0 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('REACH_SEND_QUEUE'));
    expect(await dueAt(d1, 'org_a')).toBe(T0 - MINUTE);
    warn.mockRestore();
  });

  it('retries a workspace it could not enqueue in two minutes', async () => {
    const { d1, env } = setup();
    await markWorkspaceDue(d1, 'reach_send', 'org_a', T0 - MINUTE);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = { ...env, REACH_SEND_QUEUE: { send: async () => Promise.reject(new Error('queue down')) } } as unknown as Env;
    const result = await runSendSweep(failing, new Date(T0));
    expect(result).toMatchObject({ due: 1, processed: 0, failed: 1 });
    expect(await dueAt(d1, 'org_a')).toBe(T0 + 2 * MINUTE);
    error.mockRestore();
  });

  it('does not sweep without the D1 binding', async () => {
    const queue = queueSpy<ReachSendMessage>();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await runSendSweep({ WORKSPACE_CACHE: createMemoryKv(), REACH_SEND_QUEUE: queue } as unknown as Env, new Date(T0));
    expect(result.due).toBe(0);
    expect(queue.sent).toEqual([]);
    warn.mockRestore();
  });
});

describe('settleSendDue', () => {
  it('replaces the provisional time with the real one, later or earlier', async () => {
    const { d1 } = setup();
    await markWorkspaceDue(d1, 'reach_send', 'org_a', T0 + 10 * MINUTE);
    const row = await readSendDueRow(d1, 'org_a');
    await settleSendDue(d1, 'org_a', row, new Date(T0 + 6 * 60 * MINUTE));
    expect(await dueAt(d1, 'org_a')).toBe(T0 + 6 * 60 * MINUTE);
  });

  it('drops the row when nothing is left to send', async () => {
    const { d1 } = setup();
    await markWorkspaceDue(d1, 'reach_send', 'org_a', T0);
    await settleSendDue(d1, 'org_a', await readSendDueRow(d1, 'org_a'), null);
    expect(await dueAt(d1, 'org_a')).toBeNull();
  });

  it('never overwrites a write that landed after the row was read (a launch during the tick)', async () => {
    const { d1 } = setup();
    await markWorkspaceDue(d1, 'reach_send', 'org_a', T0 + 10 * MINUTE);
    const row = await readSendDueRow(d1, 'org_a');
    await markWorkspaceDue(d1, 'reach_send', 'org_a', T0 + MINUTE); // someone launched a campaign
    await settleSendDue(d1, 'org_a', row, new Date(T0 + 6 * 60 * MINUTE));
    expect(await dueAt(d1, 'org_a')).toBe(T0 + MINUTE);
    await settleSendDue(d1, 'org_a', row, null);
    expect(await dueAt(d1, 'org_a')).toBe(T0 + MINUTE);
  });

  it('creates the row when it vanished, and tolerates a missing binding', async () => {
    const { d1 } = setup();
    await settleSendDue(d1, 'org_a', null, new Date(T0 + 5 * MINUTE));
    expect(await dueAt(d1, 'org_a')).toBe(T0 + 5 * MINUTE);
    await expect(settleSendDue(undefined, 'org_a', null, new Date(T0))).resolves.toBeUndefined();
    expect(await readSendDueRow(undefined, 'org_a')).toBeNull();
  });
});
