/** Dispatch against a pglite master DB: claiming, stale reclaim, expiry, queue hand-off. */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { MasterDatabase } from '@weldsuite/worker-kit/db';
import {
  CLAIM_LIMIT,
  QUEUE_BATCH_SIZE,
  claimDueEngagements,
  claimDueSends,
  runDispatch,
  runDispatchTick,
} from './dispatch';
import { resetKillSwitchLog } from './lib/flag';
import { flagship, messages, resetMaster, seedMailbox, seedMessage, testEnv } from './test-support/fixtures';

const NOW = new Date('2026-10-13T10:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

let master: MasterDatabase;

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db as MasterDatabase;
}, 120_000);

beforeEach(async () => {
  await resetMaster(master);
  resetKillSwitchLog();
  await seedMailbox(master, { id: 'a1' });
  await seedMailbox(master, { id: 'b1' });
});

function queues() {
  return {
    send: { sendBatch: vi.fn(async (_messages: unknown[]) => undefined) },
    engage: { sendBatch: vi.fn(async (_messages: unknown[]) => undefined) },
  };
}

function envWith(q: ReturnType<typeof queues>, extra: Record<string, unknown> = {}) {
  return testEnv({
    WARMUP_SEND_QUEUE: q.send as unknown as Queue<{ messageId: string }>,
    WARMUP_ENGAGE_QUEUE: q.engage as unknown as Queue<{ messageId: string }>,
    ...extra,
  });
}

const tick = (env = testEnv(), now = NOW) => runDispatchTick(env, { db: master, now: () => now });

const row = async (id: string) => (await master.select().from(messages).where(eq(messages.id, id)))[0]!;

function due(id: string, overrides: Partial<typeof messages.$inferInsert> = {}) {
  return seedMessage(master, { id, fromMailboxId: 'a1', toMailboxId: 'b1', scheduledAt: minutes(-1), ...overrides });
}

describe('sends', () => {
  it('queues scheduled messages whose time has come, and claims them', async () => {
    await due('due');
    await due('future', { scheduledAt: minutes(5) });
    await due('sent', { status: 'sent', engageAt: minutes(60) });
    const q = queues();

    const result = await tick(envWith(q));

    expect(result).toMatchObject({ status: 'ok', sendQueued: 1, engageQueued: 0 });
    expect(q.send.sendBatch).toHaveBeenCalledExactlyOnceWith([{ body: { messageId: 'due' } }]);
    expect((await row('due')).claimedAt).toEqual(NOW);
    expect((await row('future')).claimedAt).toBeNull();
  });

  it('does not hand out a claimed message again', async () => {
    await due('due');
    const q = queues();

    await tick(envWith(q));
    await tick(envWith(q), minutes(1));

    expect(q.send.sendBatch).toHaveBeenCalledTimes(1);
  });

  it('reclaims a claim older than 10 minutes, not a fresher one', async () => {
    await due('stale', { claimedAt: minutes(-11) });
    await due('fresh', { claimedAt: minutes(-5) });
    const q = queues();

    await tick(envWith(q));

    expect(q.send.sendBatch).toHaveBeenCalledExactlyOnceWith([{ body: { messageId: 'stale' } }]);
    expect((await row('stale')).claimedAt).toEqual(NOW);
    expect((await row('fresh')).claimedAt).toEqual(minutes(-5));
  });

  it('hands out the oldest first and at most the limit', async () => {
    for (let i = 0; i < 5; i++) await due(`m${i}`, { scheduledAt: minutes(-10 + i) });

    expect(await claimDueSends(master, NOW, 3)).toEqual(['m0', 'm1', 'm2']);
    expect(await claimDueSends(master, NOW, 3)).toEqual(['m3', 'm4']);
    expect(CLAIM_LIMIT).toBe(200);
  });

  it('two overlapping runs never claim the same message', async () => {
    for (let i = 0; i < 12; i++) await due(`m${i}`);

    const [first, second] = await Promise.all([claimDueSends(master, NOW), claimDueSends(master, NOW)]);

    expect([...first, ...second].sort()).toEqual(Array.from({ length: 12 }, (_, i) => `m${i}`).sort());
    expect(new Set([...first, ...second]).size).toBe(12);
  });

  it('sends the queue in batches of at most 100', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({
      id: `bulk${i}`,
      threadId: `th${i}`,
      step: 0,
      fromMailboxId: 'a1',
      toMailboxId: 'b1',
      corpusThreadId: 'stub-001',
      messageIdHeader: `bulk${i}@a1.test`,
      subject: 'Hello',
      status: 'scheduled' as const,
      scheduledAt: minutes(-1),
    }));
    await master.insert(messages).values(rows);
    const q = queues();

    const result = await tick(envWith(q));

    expect(result.sendQueued).toBe(150);
    expect(q.send.sendBatch.mock.calls.map(([batch]) => (batch as unknown[]).length)).toEqual([QUEUE_BATCH_SIZE, 50]);
  });

  it('gives the claims back when the queue refuses the batch', async () => {
    await due('due');
    const q = queues();
    q.send.sendBatch.mockRejectedValueOnce(new Error('queue down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await tick(envWith(q));

    expect(result.sendQueued).toBe(0);
    expect((await row('due')).claimedAt).toBeNull();
    // The next tick tries again.
    await tick(envWith(q), minutes(1));
    expect(q.send.sendBatch).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it('fails messages that are hours overdue instead of sending them late', async () => {
    await due('late', { scheduledAt: minutes(-7 * 60) });
    await due('slightly-late', { scheduledAt: minutes(-5 * 60) });
    const q = queues();

    const result = await tick(envWith(q));

    expect(result.expired).toBe(1);
    expect(await row('late')).toMatchObject({ status: 'failed', error: 'expired' });
    expect(q.send.sendBatch).toHaveBeenCalledExactlyOnceWith([{ body: { messageId: 'slightly-late' } }]);
  });
});

describe('engagements', () => {
  const sent = (id: string, overrides: Partial<typeof messages.$inferInsert> = {}) =>
    seedMessage(master, {
      id,
      fromMailboxId: 'a1',
      toMailboxId: 'b1',
      status: 'sent',
      sentAt: minutes(-90),
      engageAt: minutes(-1),
      ...overrides,
    });

  it('queues sent messages whose engagement time has come', async () => {
    await sent('now');
    await sent('later', { engageAt: minutes(30) });
    await due('unsent');
    const q = queues();

    const result = await tick(envWith(q));

    expect(result.engageQueued).toBe(1);
    expect(q.engage.sendBatch).toHaveBeenCalledExactlyOnceWith([{ body: { messageId: 'now' } }]);
    expect((await row('now')).claimedAt).toEqual(NOW);
  });

  it('stops after three attempts', async () => {
    await sent('tried-twice', { engageAttempts: 2 });
    await sent('tried-thrice', { engageAttempts: 3 });

    expect(await claimDueEngagements(master, NOW)).toEqual(['tried-twice']);
  });

  it('reclaims a stale engagement claim', async () => {
    await sent('stale', { claimedAt: minutes(-30) });
    await sent('fresh', { claimedAt: minutes(-2) });

    expect(await claimDueEngagements(master, NOW)).toEqual(['stale']);
  });
});

describe('configuration', () => {
  it('skips a queue that is not bound and leaves its rows unclaimed', async () => {
    await due('due');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await tick(testEnv());

    expect(result).toMatchObject({ status: 'ok', sendQueued: 0, engageQueued: 0 });
    expect((await row('due')).claimedAt).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('does nothing while the kill switch is off', async () => {
    await due('due');
    await due('late', { scheduledAt: minutes(-7 * 60) });
    const q = queues();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await tick(envWith(q, { FLAGSHIP: flagship(false) }));

    expect(result.status).toBe('disabled');
    expect(q.send.sendBatch).not.toHaveBeenCalled();
    expect((await row('due')).claimedAt).toBeNull();
    expect((await row('late')).status).toBe('scheduled');
    log.mockRestore();
  });

  it('runDispatch is the cron entry point and resolves to nothing', async () => {
    await due('due');
    const q = queues();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(runDispatch(envWith(q), { db: master, now: () => NOW })).resolves.toBeUndefined();

    expect(q.send.sendBatch).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});
