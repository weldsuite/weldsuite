/**
 * Planner against a pglite master DB: pool minimum, start, ramp and
 * maintenance targets, business hours per timezone, pairing rules, idempotency.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  WARMUP_MAINTAIN_MAX,
  WARMUP_MAINTAIN_MIN,
  WARMUP_MIN_POOL_DOMAINS,
  warmupRampTarget,
} from '@weldsuite/reach-domain/warmup';
import { newThreadsFor } from './schedule';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { MasterDatabase } from '@weldsuite/worker-kit/db';
import { loadCorpus } from './corpus';
import { STUB_THREADS } from './test-support/corpus-stub';
import { resetKillSwitchLog } from './lib/flag';
import { runPlanner, runPlannerTick } from './planner';
import {
  flagship,
  messages,
  pool,
  resetMaster,
  seedMailbox,
  seedMessage,
  seeded,
  testEnv,
  type MailboxSeed,
} from './test-support/fixtures';

vi.mock('./corpus', () => import('./test-support/corpus-stub'));

/** Tuesday 00:10 UTC: the start of the day for every UTC mailbox. */
const NOW = new Date('2026-10-13T00:10:00Z');
const TODAY = '2026-10-13';

let master: MasterDatabase;

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db as MasterDatabase;
}, 120_000);

beforeEach(async () => {
  await resetMaster(master);
  resetKillSwitchLog();
  vi.mocked(loadCorpus).mockClear();
});

/** Three mailboxes on three domains: the smallest pool the planner works with. */
async function seedMinimalPool(overrides: Partial<MailboxSeed> = {}): Promise<string[]> {
  return Promise.all(
    ['a1', 'b1', 'c1'].map((id) => seedMailbox(master, { id, ...overrides })),
  );
}

function tick(now = NOW, seed = 1, env = testEnv()) {
  return runPlannerTick(env, { db: master, now: () => now, random: seeded(seed) });
}

const allMessages = () => master.select().from(messages);
const mailboxRow = async (id: string) => (await master.select().from(pool).where(eq(pool.id, id)))[0]!;

describe('pool minimum', () => {
  it(`plans nothing below ${WARMUP_MIN_POOL_DOMAINS} domains and leaves waiting mailboxes waiting`, async () => {
    await seedMailbox(master, { id: 'a1', status: 'waiting', rampDay: 0 });
    await seedMailbox(master, { id: 'a2', domain: 'a1.test', status: 'waiting', rampDay: 0 });
    await seedMailbox(master, { id: 'b1', status: 'waiting', rampDay: 0 });

    const result = await tick();

    expect(result).toMatchObject({ status: 'pool_too_small', poolDomains: 2, started: 0, messagesPlanned: 0 });
    expect(await allMessages()).toHaveLength(0);
    for (const id of ['a1', 'a2', 'b1']) {
      expect(await mailboxRow(id)).toMatchObject({ status: 'waiting', startedAt: null, rampDay: 0 });
    }
  });

  it('does not count paused, errored or removed mailboxes toward the minimum', async () => {
    await seedMailbox(master, { id: 'a1' });
    await seedMailbox(master, { id: 'b1' });
    await seedMailbox(master, { id: 'c1', status: 'paused' });
    await seedMailbox(master, { id: 'd1', status: 'error' });
    await seedMailbox(master, { id: 'e1', status: 'removed' });

    expect((await tick()).status).toBe('pool_too_small');
    expect(await allMessages()).toHaveLength(0);
  });

  it('starts planning once the pool spans three domains', async () => {
    await seedMailbox(master, { id: 'a1', status: 'waiting' });
    await seedMailbox(master, { id: 'b1', status: 'waiting' });
    expect((await tick()).status).toBe('pool_too_small');

    await seedMailbox(master, { id: 'c1', status: 'waiting' });
    const result = await tick();
    expect(result.status).toBe('ok');
    expect(result.started).toBe(3);
    expect((await allMessages()).length).toBeGreaterThan(0);
  });
});

describe('starting mailboxes', () => {
  it('moves waiting to warming on ramp day 1 with its start recorded', async () => {
    await seedMinimalPool({ status: 'waiting', rampDay: 0 });

    const result = await tick();

    expect(result.started).toBe(3);
    for (const id of ['a1', 'b1', 'c1']) {
      expect(await mailboxRow(id)).toMatchObject({
        status: 'warming',
        rampDay: 1,
        startedAt: NOW,
        rampUpdatedAt: NOW,
        plannedFor: TODAY,
        dailyTarget: newThreadsFor(warmupRampTarget(1)),
      });
    }
    expect(await allMessages()).toHaveLength(3 * newThreadsFor(warmupRampTarget(1)));
  });
});

describe('daily targets', () => {
  it('plans the ramp target for the mailbox ramp day while warming', async () => {
    await Promise.all(
      [
        ['a1', 5],
        ['b1', 9],
        ['c1', 14],
      ].map(([id, rampDay]) => seedMailbox(master, { id: id as string, rampDay: rampDay as number })),
    );

    await tick();

    const rows = await allMessages();
    const sentBy = (id: string) => rows.filter((row) => row.fromMailboxId === id).length;
    expect(sentBy('a1')).toBe(newThreadsFor(warmupRampTarget(5)));
    expect(sentBy('b1')).toBe(newThreadsFor(warmupRampTarget(9)));
    expect(sentBy('c1')).toBe(newThreadsFor(warmupRampTarget(14)));
    expect((await mailboxRow('c1')).dailyTarget).toBe(newThreadsFor(40));
  });

  it('plans between the maintenance bounds while maintaining', async () => {
    await seedMinimalPool({ status: 'maintaining', rampDay: 30 });

    await tick();

    for (const id of ['a1', 'b1', 'c1']) {
      const sent = (await allMessages()).filter((row) => row.fromMailboxId === id).length;
      expect(sent).toBeGreaterThanOrEqual(newThreadsFor(WARMUP_MAINTAIN_MIN));
      expect(sent).toBeLessThanOrEqual(newThreadsFor(WARMUP_MAINTAIN_MAX));
    }
  });
});

describe('the messages', () => {
  it('stores scheduled step-0 messages with a Message-ID from the sender domain, before any send', async () => {
    await seedMinimalPool({ rampDay: 6 });

    await tick();

    const rows = await allMessages();
    expect(rows).toHaveLength(3 * newThreadsFor(warmupRampTarget(6)));
    const ids = new Set<string>();
    for (const row of rows) {
      expect(row).toMatchObject({ step: 0, status: 'scheduled', inReplyTo: null, references: null, sentAt: null });
      expect(row.id).toMatch(/^rwms_/);
      expect(row.threadId).toMatch(/^rwth_/);
      expect(row.messageIdHeader).toMatch(new RegExp(`^[0-9a-f]{32}\\.[a-z0-9]+@${row.fromMailboxId}\\.test$`));
      expect(STUB_THREADS.map((thread) => thread.id)).toContain(row.corpusThreadId);
      expect(row.subject).toBe(STUB_THREADS.find((thread) => thread.id === row.corpusThreadId)!.subject);
      ids.add(row.messageIdHeader);
    }
    expect(ids.size).toBe(rows.length);
  });

  it('spreads each mailbox over its business hours, in its own timezone', async () => {
    // Amsterdam (CEST, +2): 09:00-17:30 is 07:00-15:30 UTC. New York (EDT, -4): 13:00-21:30 UTC.
    await seedMailbox(master, { id: 'a1', timezone: 'Europe/Amsterdam', rampDay: 14 });
    await seedMailbox(master, { id: 'b1', timezone: 'Europe/Amsterdam', rampDay: 14 });
    await seedMailbox(master, { id: 'c1', timezone: 'America/New_York', rampDay: 14 });

    // 05:00 UTC: Tuesday 07:00 Amsterdam, 01:00 New York. Both days are still ahead.
    await tick(new Date('2026-10-13T05:00:00Z'));

    const rows = await allMessages();
    const from = (id: string) => rows.filter((row) => row.fromMailboxId === id).map((row) => row.scheduledAt.getTime());
    const within = (times: number[], start: string, end: string) =>
      times.every((t) => t >= new Date(start).getTime() && t <= new Date(end).getTime());
    expect(from('a1')).toHaveLength(newThreadsFor(40));
    expect(within(from('a1'), '2026-10-13T07:00:00Z', '2026-10-13T15:30:00Z')).toBe(true);
    expect(within(from('b1'), '2026-10-13T07:00:00Z', '2026-10-13T15:30:00Z')).toBe(true);
    expect(from('c1')).toHaveLength(newThreadsFor(40));
    expect(within(from('c1'), '2026-10-13T13:00:00Z', '2026-10-13T21:30:00Z')).toBe(true);
    // Spread over the day, not bunched: the sends cover most of the window.
    const a = from('a1');
    expect(Math.max(...a) - Math.min(...a)).toBeGreaterThan(6 * 3_600_000);
  });

  it('plans against the mailbox local date, not the UTC date', async () => {
    await seedMailbox(master, { id: 'a1', timezone: 'America/New_York', rampDay: 3 });
    await seedMailbox(master, { id: 'b1', timezone: 'America/New_York', rampDay: 3 });
    await seedMailbox(master, { id: 'c1', timezone: 'America/New_York', rampDay: 3 });

    // 00:10 UTC Tuesday is Monday 20:10 in New York: Monday's business hours are over.
    await tick(NOW);
    expect(await allMessages()).toHaveLength(0);
    expect((await mailboxRow('a1')).plannedFor).toBe('2026-10-12');

    // 04:10 UTC is Tuesday 00:10 in New York: a new local day, planned in full.
    await tick(new Date('2026-10-13T04:10:00Z'));
    const rows = await allMessages();
    expect(rows).toHaveLength(3 * newThreadsFor(warmupRampTarget(3)));
    expect((await mailboxRow('a1')).plannedFor).toBe('2026-10-13');
  });

  it('plans nothing on a weekend but still marks the day planned', async () => {
    await seedMinimalPool({ rampDay: 14 });

    const saturday = new Date('2026-10-17T00:10:00Z');
    const result = await tick(saturday);

    expect(result.messagesPlanned).toBe(0);
    expect(await allMessages()).toHaveLength(0);
    expect(await mailboxRow('a1')).toMatchObject({ plannedFor: '2026-10-17', dailyTarget: 0 });
  });

  it('plans proportionally fewer when the business day is half over', async () => {
    await seedMinimalPool({ rampDay: 14 });

    // 13:15 UTC: 4h15 of the 8h30 window (09:00-17:30 UTC) is left.
    await tick(new Date('2026-10-13T13:15:00Z'));

    const rows = await allMessages();
    // About half the day is left (minus the planning lead), so about half the threads.
    const half = newThreadsFor(40) / 2;
    expect(rows.length).toBeGreaterThanOrEqual(3 * Math.floor(half));
    expect(rows.length).toBeLessThanOrEqual(3 * Math.ceil(half));
    expect(rows.every((row) => row.scheduledAt.getTime() > new Date('2026-10-13T13:15:00Z').getTime())).toBe(true);
    expect(rows.every((row) => row.scheduledAt.getTime() <= new Date('2026-10-13T17:30:00Z').getTime())).toBe(true);
  });
});

describe('idempotency', () => {
  it('does not plan a mailbox twice for the same local day', async () => {
    await seedMinimalPool({ rampDay: 4 });

    const first = await tick();
    const second = await tick(new Date('2026-10-13T00:40:00Z'), 2);
    const later = await tick(new Date('2026-10-13T12:00:00Z'), 3);

    expect(first.mailboxesPlanned).toBe(3);
    expect(second.mailboxesPlanned).toBe(0);
    expect(later.mailboxesPlanned).toBe(0);
    expect(await allMessages()).toHaveLength(3 * newThreadsFor(warmupRampTarget(4)));
  });

  it('plans the next local day again', async () => {
    await seedMinimalPool({ rampDay: 4 });

    await tick();
    await tick(new Date('2026-10-14T00:10:00Z'));

    expect(await allMessages()).toHaveLength(2 * 3 * newThreadsFor(warmupRampTarget(4)));
    expect((await mailboxRow('a1')).plannedFor).toBe('2026-10-14');
  });

  it('gives the day back when planning fails, so the next run plans it', async () => {
    await seedMinimalPool({ rampDay: 4 });
    const broken = [{ id: 'bad', subject: 'Empty', messages: [] }];
    vi.mocked(loadCorpus).mockResolvedValueOnce(broken);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const failed = await tick();
    expect(failed.messagesPlanned).toBe(0);
    expect(await allMessages()).toHaveLength(0);
    expect((await mailboxRow('a1')).plannedFor).toBeNull();
    expect(error).toHaveBeenCalled();
    error.mockRestore();

    const retry = await tick(new Date('2026-10-13T00:40:00Z'), 2);
    expect(retry.messagesPlanned).toBe(3 * newThreadsFor(warmupRampTarget(4)));
  });
});

describe('pairing', () => {
  async function seedLargePool(): Promise<void> {
    // 6 domains x 2 mailboxes, alternating type, all at the full ramp (40 a day).
    for (const domain of ['d1', 'd2', 'd3', 'd4', 'd5', 'd6']) {
      for (const n of [1, 2]) {
        await seedMailbox(master, {
          id: `${domain}m${n}`,
          domain: `${domain}.test`,
          mailboxType: n === 1 ? 'google' : 'shared',
          workspaceId: `ws_${domain}`,
          rampDay: 14,
        });
      }
    }
  }

  it('never pairs a mailbox with its own domain', async () => {
    await seedLargePool();
    await tick();

    const byId = new Map((await master.select().from(pool)).map((row) => [row.id, row]));
    const rows = await allMessages();
    expect(rows).toHaveLength(12 * newThreadsFor(40));
    for (const row of rows) {
      expect(byId.get(row.fromMailboxId)!.domain).not.toBe(byId.get(row.toMailboxId)!.domain);
    }
  });

  it('spreads every mailbox over all the other domains', async () => {
    await seedLargePool();
    await tick();

    const byId = new Map((await master.select().from(pool)).map((row) => [row.id, row]));
    const rows = await allMessages();
    for (const sender of byId.values()) {
      const perDomain = new Map<string, number>();
      for (const row of rows.filter((r) => r.fromMailboxId === sender.id)) {
        const domain = byId.get(row.toMailboxId)!.domain;
        perDomain.set(domain, (perDomain.get(domain) ?? 0) + 1);
      }
      expect(perDomain.size).toBe(5);
      const counts = [...perDomain.values()];
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(2);
    }
  });

  it('mixes mailbox types and keeps received roughly equal to sent', async () => {
    await seedLargePool();
    await tick();

    const byId = new Map((await master.select().from(pool)).map((row) => [row.id, row]));
    const rows = await allMessages();
    const received = new Map<string, number>();
    let mixed = 0;
    for (const row of rows) {
      received.set(row.toMailboxId, (received.get(row.toMailboxId) ?? 0) + 1);
      if (byId.get(row.fromMailboxId)!.mailboxType !== byId.get(row.toMailboxId)!.mailboxType) mixed++;
    }
    // Every mailbox starts the same number of threads; none receives far off that.
    const sent = newThreadsFor(40);
    for (const id of byId.keys()) {
      expect(received.get(id) ?? 0).toBeGreaterThanOrEqual(Math.round(sent * 0.6));
      expect(received.get(id) ?? 0).toBeLessThanOrEqual(Math.round(sent * 1.4));
    }
    // Half of the pool is the other type; the mix leans to the other type.
    expect(mixed / rows.length).toBeGreaterThan(0.5);
  });

  it('prefers recipients from other workspaces', async () => {
    // a1 and a2 share a workspace; b1 is another workspace. Same domains, same type.
    await seedMailbox(master, { id: 'a1', workspaceId: 'ws_a', rampDay: 14 });
    await seedMailbox(master, { id: 'a2', workspaceId: 'ws_a', rampDay: 14 });
    await seedMailbox(master, { id: 'b1', workspaceId: 'ws_b', rampDay: 14 });
    await seedMailbox(master, { id: 'c1', workspaceId: 'ws_a', rampDay: 14 });

    await tick();

    const rows = await allMessages();
    const fromA1 = rows.filter((row) => row.fromMailboxId === 'a1');
    const toB1 = fromA1.filter((row) => row.toMailboxId === 'b1').length;
    // b1 is the only other-workspace recipient: it gets at least its even share.
    expect(toB1).toBeGreaterThanOrEqual(Math.floor(fromA1.length / 3));
  });

  it('keeps a pair that started a thread in the last 3 days apart while others are free', async () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      await resetMaster(master);
      await seedMailbox(master, { id: 'a1', rampDay: 1 });
      await seedMailbox(master, { id: 'b1', rampDay: 1 });
      await seedMailbox(master, { id: 'b2', domain: 'b1.test', rampDay: 1 });
      await seedMailbox(master, { id: 'c1', rampDay: 1 });
      await seedMailbox(master, { id: 'd1', rampDay: 1 });
      await seedMailbox(master, { id: 'e1', rampDay: 1 });
      await seedMessage(master, {
        id: 'old',
        fromMailboxId: 'a1',
        toMailboxId: 'b1',
        status: 'sent',
        scheduledAt: new Date(NOW.getTime() - 24 * 3_600_000),
        sentAt: new Date(NOW.getTime() - 24 * 3_600_000),
      });

      await tick(NOW, seed);

      const fresh = (await allMessages()).filter((row) => row.id !== 'old');
      expect(fresh.length).toBeGreaterThan(0);
      for (const row of fresh) {
        const pair = [row.fromMailboxId, row.toMailboxId].sort().join('|');
        expect(pair).not.toBe('a1|b1');
      }
    }
  });

  it('does not let a pair that started a thread long ago hold the pair back', async () => {
    await seedMinimalPool({ rampDay: 14 });
    await seedMessage(master, {
      id: 'ancient',
      fromMailboxId: 'a1',
      toMailboxId: 'b1',
      status: 'engaged',
      scheduledAt: new Date(NOW.getTime() - 10 * 24 * 3_600_000),
    });

    await tick();

    const fresh = (await allMessages()).filter((row) => row.id !== 'ancient');
    expect(fresh.some((row) => row.fromMailboxId === 'a1' && row.toMailboxId === 'b1')).toBe(true);
  });

  it('does not pick paused, errored or removed mailboxes as recipients, nor plan them', async () => {
    await seedMinimalPool({ rampDay: 4 });
    await seedMailbox(master, { id: 'p1', status: 'paused', rampDay: 4 });
    await seedMailbox(master, { id: 'e1', status: 'error', rampDay: 4 });
    await seedMailbox(master, { id: 'r1', status: 'removed', rampDay: 4 });

    await tick();

    const rows = await allMessages();
    const touched = new Set(rows.flatMap((row) => [row.fromMailboxId, row.toMailboxId]));
    expect([...touched].sort()).toEqual(['a1', 'b1', 'c1']);
  });
});

describe('kill switch', () => {
  it('does nothing while weldreach-warmup is off', async () => {
    await seedMinimalPool({ status: 'waiting', rampDay: 0 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const env = testEnv({ FLAGSHIP: flagship(false) });

    expect((await tick(NOW, 1, env)).status).toBe('disabled');
    await tick(NOW, 1, env);

    expect(await allMessages()).toHaveLength(0);
    expect(await mailboxRow('a1')).toMatchObject({ status: 'waiting' });
    expect(env.FLAGSHIP!.getBooleanValue).toHaveBeenCalledWith('weldreach-warmup', true, expect.anything());
    // Logged once, not on every tick.
    expect(log.mock.calls.filter(([line]) => String(line).includes('kill switch'))).toHaveLength(1);
    log.mockRestore();
  });

  it('runs when the flag is on, and by default when Flagship is not bound', async () => {
    await seedMinimalPool({ rampDay: 3 });
    expect((await tick(NOW, 1, testEnv({ FLAGSHIP: flagship(true) }))).status).toBe('ok');

    await resetMaster(master);
    await seedMinimalPool({ rampDay: 3 });
    expect((await tick(NOW, 1, testEnv())).status).toBe('ok');
    expect((await allMessages()).length).toBeGreaterThan(0);
  });
});

describe('runPlanner', () => {
  it('is the cron entry point and resolves to nothing', async () => {
    await seedMinimalPool({ rampDay: 3 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(runPlanner(testEnv(), { db: master, now: () => NOW, random: seeded(1) })).resolves.toBeUndefined();
    log.mockRestore();
    expect(await allMessages()).toHaveLength(3 * newThreadsFor(warmupRampTarget(3)));
  });
});
