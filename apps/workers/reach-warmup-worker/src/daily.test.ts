/**
 * Daily job against a pglite master DB: ramp, stats rollup, auto-pause and its
 * cool-off, the kill switch and the corpus refresh. Cleanup has its own file.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { WARMUP_MIN_DAYS } from '@weldsuite/reach-domain/warmup';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { MasterDatabase } from '@weldsuite/worker-kit/db';
import { refreshCorpus } from './corpus';
import { AUTO_PAUSE_INBOX_RATE, LOW_RATE_COOL_OFF_DAYS, advanceRamp, runDaily, runDailyTick } from './daily';
import { resetKillSwitchLog } from './lib/flag';
import {
  createDueIndex,
  dueAt,
  flagship,
  messages,
  pool,
  resetMaster,
  seedMailbox,
  seedMessage,
  testEnv,
} from './test-support/fixtures';

vi.mock('./corpus', () => import('./test-support/corpus-stub'));
vi.mock('@weldsuite/imap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/imap')>()),
  connectImap: vi.fn(),
}));

const NOW = new Date('2026-10-13T02:30:00Z');
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
const YESTERDAY_NOON = new Date('2026-10-12T12:00:00Z');

let master: MasterDatabase;
let counter = 0;

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db as MasterDatabase;
}, 120_000);

beforeEach(async () => {
  await resetMaster(master);
  resetKillSwitchLog();
  vi.mocked(refreshCorpus).mockReset();
  vi.mocked(refreshCorpus).mockResolvedValue({ refreshed: false });
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  log.mockClear();
});

const tick = (env = testEnv()) => runDailyTick(env, { db: master, now: () => NOW });
const mailbox = async (id: string) => (await master.select().from(pool).where(eq(pool.id, id)))[0]!;

interface BatchOptions {
  from: string;
  to: string;
  count: number;
  /** When it was sent. */
  sentAt: Date;
  placement?: 'inbox' | 'spam' | 'missing' | null;
  /** How many of them the engager moved out of spam. */
  moved?: number;
  status?: 'engaged' | 'missing' | 'sent' | 'failed' | 'scheduled';
}

/** `count` messages from one mailbox to another, with the given outcome. */
async function seedBatch(options: BatchOptions): Promise<void> {
  const placement = options.placement === undefined ? 'inbox' : options.placement;
  const status = options.status ?? (placement === 'missing' ? 'missing' : placement === null ? 'sent' : 'engaged');
  for (let i = 0; i < options.count; i++) {
    counter++;
    await seedMessage(master, {
      id: `b${counter}`,
      fromMailboxId: options.from,
      toMailboxId: options.to,
      messageIdHeader: `b${counter}@${options.from}.test`,
      status,
      placement,
      sentAt: status === 'failed' || status === 'scheduled' ? null : options.sentAt,
      actions: placement === 'spam' && i < (options.moved ?? 0) ? { seen: true, movedFromSpam: true } : null,
      scheduledAt: options.sentAt,
    });
  }
}

describe('ramp', () => {
  it('moves mailboxes that sent yesterday one ramp day on, and no one else', async () => {
    await seedMailbox(master, { id: 'sent', rampDay: 3, rampUpdatedAt: daysAgo(2) });
    await seedMailbox(master, { id: 'idle', rampDay: 3, rampUpdatedAt: daysAgo(2) });
    await seedMailbox(master, { id: 'today', rampDay: 3, rampUpdatedAt: daysAgo(2) });
    await seedMailbox(master, { id: 'maint', rampDay: 20, status: 'maintaining', rampUpdatedAt: daysAgo(2) });
    await seedMailbox(master, { id: 'paused', rampDay: 3, status: 'paused', rampUpdatedAt: daysAgo(2) });
    await seedMailbox(master, { id: 'z' });
    for (const from of ['sent', 'maint', 'paused']) {
      await seedBatch({ from, to: 'z', count: 1, sentAt: YESTERDAY_NOON, placement: null });
    }
    // Sent after midnight UTC: that is today, not yesterday.
    await seedBatch({ from: 'today', to: 'z', count: 1, sentAt: new Date('2026-10-13T01:00:00Z'), placement: null });
    // Planned yesterday but never sent: no ramp day.
    await seedBatch({ from: 'idle', to: 'z', count: 3, sentAt: YESTERDAY_NOON, status: 'failed', placement: null });

    const result = await tick();

    expect(result.advanced).toBe(2);
    expect((await mailbox('sent')).rampDay).toBe(4);
    expect((await mailbox('sent')).rampUpdatedAt).toEqual(NOW);
    expect((await mailbox('maint')).rampDay).toBe(21);
    expect((await mailbox('idle')).rampDay).toBe(3);
    expect((await mailbox('today')).rampDay).toBe(3);
    expect((await mailbox('paused')).rampDay).toBe(3);
  });

  it('advances nobody twice in one UTC day', async () => {
    await seedMailbox(master, { id: 'a1', rampDay: 3, rampUpdatedAt: daysAgo(2) });
    await seedBatch({ from: 'a1', to: 'z', count: 2, sentAt: YESTERDAY_NOON, placement: null });

    await tick();
    await tick();
    const later = await runDailyTick(testEnv(), { db: master, now: () => new Date('2026-10-13T23:00:00Z') });

    expect((await mailbox('a1')).rampDay).toBe(4);
    expect(later.advanced).toBe(0);
  });

  it('does not advance a mailbox that was started or ramped today', async () => {
    await seedMailbox(master, { id: 'a1', rampDay: 1, rampUpdatedAt: new Date('2026-10-13T00:10:00Z') });
    await seedBatch({ from: 'a1', to: 'z', count: 1, sentAt: YESTERDAY_NOON, placement: null });

    await tick();

    expect((await mailbox('a1')).rampDay).toBe(1);
  });

  it(`turns a warming mailbox into maintaining at ${WARMUP_MIN_DAYS} days`, async () => {
    await seedMailbox(master, { id: 'almost', rampDay: WARMUP_MIN_DAYS - 1, rampUpdatedAt: daysAgo(2) });
    await seedMailbox(master, { id: 'early', rampDay: WARMUP_MIN_DAYS - 2, rampUpdatedAt: daysAgo(2) });
    for (const from of ['almost', 'early']) await seedBatch({ from, to: 'z', count: 1, sentAt: YESTERDAY_NOON, placement: null });

    const result = await tick();

    expect(result.graduated).toBe(1);
    expect(await mailbox('almost')).toMatchObject({ status: 'maintaining', rampDay: WARMUP_MIN_DAYS });
    expect(await mailbox('early')).toMatchObject({ status: 'warming', rampDay: WARMUP_MIN_DAYS - 1 });
  });

  it('advanceRamp can be called on its own', async () => {
    await seedMailbox(master, { id: 'a1', rampDay: 5, rampUpdatedAt: daysAgo(3) });
    await seedBatch({ from: 'a1', to: 'z', count: 1, sentAt: YESTERDAY_NOON, placement: null });

    expect(await advanceRamp(master, NOW)).toEqual({ advanced: 1, graduated: 0 });
  });
});

describe('stats rollup', () => {
  it('counts a mailbox own mail by where it landed, over 3 and 7 days', async () => {
    await seedMailbox(master, { id: 's' });
    await seedMailbox(master, { id: 'r1' });
    await seedMailbox(master, { id: 'r2' });
    // Last 3 days: 8 inbox, 1 spam (rescued), 1 missing.
    await seedBatch({ from: 's', to: 'r1', count: 8, sentAt: daysAgo(1), placement: 'inbox' });
    await seedBatch({ from: 's', to: 'r2', count: 1, sentAt: daysAgo(1), placement: 'spam', moved: 1 });
    await seedBatch({ from: 's', to: 'r2', count: 1, sentAt: daysAgo(2), placement: 'missing' });
    // 3 to 7 days ago: 4 inbox, 2 spam (one rescued).
    await seedBatch({ from: 's', to: 'r1', count: 4, sentAt: daysAgo(5), placement: 'inbox' });
    await seedBatch({ from: 's', to: 'r2', count: 2, sentAt: daysAgo(5), placement: 'spam', moved: 1 });
    // Sent today, not engaged yet: counts as sent, judged by nobody.
    await seedBatch({ from: 's', to: 'r1', count: 2, sentAt: daysAgo(0.1), placement: null });
    // Outside the window, and never sent.
    await seedBatch({ from: 's', to: 'r1', count: 5, sentAt: daysAgo(8), placement: 'inbox' });
    await seedBatch({ from: 's', to: 'r1', count: 3, sentAt: daysAgo(1), status: 'failed', placement: null });
    await seedBatch({ from: 's', to: 'r1', count: 3, sentAt: daysAgo(-1), status: 'scheduled', placement: null });

    const result = await tick();

    expect(result.rolledUp).toBe(3);
    expect((await mailbox('s')).stats).toEqual({
      sent7d: 18,
      received7d: 0,
      inbox3d: 8,
      spam3d: 1,
      missing3d: 1,
      inbox7d: 12,
      spam7d: 3,
      missing7d: 1,
      inboxRate3d: 0.8,
      inboxRate7d: 0.75,
      spamRescues7d: 0,
      rolledUpAt: NOW.toISOString(),
    });
    // r1 received 8 + 4 + 2 mails in the window; r2 received 1 + 1 + 2 and had two rescued.
    expect((await mailbox('r1')).stats).toMatchObject({ sent7d: 0, received7d: 14, spamRescues7d: 0, inboxRate3d: null });
    expect((await mailbox('r2')).stats).toMatchObject({ received7d: 4, spamRescues7d: 2 });
  });

  it('leaves the rate empty below the minimum sample', async () => {
    await seedMailbox(master, { id: 's' });
    await seedBatch({ from: 's', to: 'z', count: 9, sentAt: daysAgo(1), placement: 'inbox' });

    await tick();

    expect((await mailbox('s')).stats).toMatchObject({ inbox3d: 9, inboxRate3d: null, inboxRate7d: null });
  });

  it('gives a mailbox without any mail zeros, and skips removed mailboxes', async () => {
    await seedMailbox(master, { id: 'quiet' });
    await seedMailbox(master, { id: 'gone', status: 'removed' });

    await tick();

    expect((await mailbox('quiet')).stats).toMatchObject({
      sent7d: 0,
      received7d: 0,
      inbox3d: 0,
      spam3d: 0,
      missing3d: 0,
      inboxRate3d: null,
      spamRescues7d: 0,
    });
    expect((await mailbox('gone')).stats).toBeNull();
  });
});

describe('auto-pause', () => {
  async function seedRates(id: string, inbox: number, spam: number, extra: Partial<typeof pool.$inferInsert> = {}) {
    await seedMailbox(master, { id, status: 'maintaining', rampDay: 20, rampUpdatedAt: new Date('2026-10-13T00:05:00Z'), ...extra });
    await seedBatch({ from: id, to: 'z', count: inbox, sentAt: daysAgo(1), placement: 'inbox' });
    await seedBatch({ from: id, to: 'z', count: spam, sentAt: daysAgo(1), placement: 'spam' });
  }

  it(`pauses a maintaining mailbox whose 3-day inbox rate is below ${AUTO_PAUSE_INBOX_RATE}`, async () => {
    await seedRates('low', 5, 5);
    await seedRates('fine', 9, 1);
    await seedRates('edge', 6, 4); // exactly 0.6: not below
    const index = createDueIndex();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await tick(testEnv({ SCHEDULE_INDEX: index }));

    expect(result.autoPaused).toEqual(['low']);
    expect(await mailbox('low')).toMatchObject({ status: 'paused', pausedReason: 'low_inbox_rate' });
    expect((await mailbox('fine')).status).toBe('maintaining');
    expect((await mailbox('edge')).status).toBe('maintaining');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('low_inbox_rate'));
    // reach-api's sweep is told the same day.
    expect(await dueAt(index, 'org_low')).toBe(NOW.getTime());
    expect(await dueAt(index, 'org_fine')).toBeNull();
    warn.mockRestore();
  });

  it('needs enough judged mail', async () => {
    await seedRates('thin', 0, 9);

    await tick();

    expect((await mailbox('thin')).status).toBe('maintaining');
  });

  it('leaves warming mailboxes and mailboxes someone else paused alone', async () => {
    await seedRates('warming', 2, 8, { status: 'warming', rampDay: 5 });
    await seedRates('byuser', 2, 8, { status: 'paused', pausedReason: 'paused_by_user' });
    await seedRates('bystaff', 2, 8, { status: 'paused', pausedReason: 'paused_by_staff' });

    const result = await tick();

    expect(result.autoPaused).toEqual([]);
    expect((await mailbox('warming')).status).toBe('warming');
    expect(await mailbox('byuser')).toMatchObject({ status: 'paused', pausedReason: 'paused_by_user' });
    expect(await mailbox('bystaff')).toMatchObject({ status: 'paused', pausedReason: 'paused_by_staff' });
  });
});

describe('cool-off after a low-placement pause', () => {
  async function seedPaused(id: string, reason: string, updatedDaysAgo: number, extra: Partial<typeof pool.$inferInsert> = {}) {
    await seedMailbox(master, {
      id,
      status: 'paused',
      pausedReason: reason,
      rampDay: 20,
      startedAt: daysAgo(30),
      updatedAt: daysAgo(updatedDaysAgo),
      ...extra,
    });
  }

  it(`lifts our own low_inbox_rate pause after ${LOW_RATE_COOL_OFF_DAYS} days, back to where the warmup had got to`, async () => {
    await seedPaused('old', 'low_inbox_rate', LOW_RATE_COOL_OFF_DAYS + 1);
    await seedPaused('oldwarming', 'low_inbox_rate', 5, { rampDay: 6 });
    await seedPaused('fresh', 'low_inbox_rate', 1);
    const index = createDueIndex();

    const result = await tick(testEnv({ SCHEDULE_INDEX: index }));

    expect(result.resumed.sort()).toEqual(['old', 'oldwarming']);
    expect(await mailbox('old')).toMatchObject({ status: 'maintaining', pausedReason: null });
    expect(await mailbox('oldwarming')).toMatchObject({ status: 'warming', pausedReason: null });
    expect(await mailbox('fresh')).toMatchObject({ status: 'paused', pausedReason: 'low_inbox_rate' });
    expect(await dueAt(index, 'org_old')).toBe(NOW.getTime());
    expect(await dueAt(index, 'org_fresh')).toBeNull();
  });

  it.each(['paused_by_user', 'paused_by_staff', 'mailbox_suspended', 'domain_inactive', 'domain_error', 'credentials_unavailable'])(
    'never lifts a pause with the reason %s',
    async (reason) => {
      await seedPaused('keep', reason, 30);

      const result = await tick();

      expect(result.resumed).toEqual([]);
      expect(await mailbox('keep')).toMatchObject({ status: 'paused', pausedReason: reason });
    },
  );

  it('does not pause a mailbox again straight after lifting its pause', async () => {
    await seedPaused('old', 'low_inbox_rate', 4);

    const first = await tick();
    const second = await tick();

    expect(first.resumed).toEqual(['old']);
    expect(second.autoPaused).toEqual([]);
    expect((await mailbox('old')).status).toBe('maintaining');
  });
});

describe('the rest of the daily job', () => {
  it('refreshes the corpus and reports it', async () => {
    vi.mocked(refreshCorpus).mockResolvedValue({ refreshed: true });

    const result = await tick();

    expect(refreshCorpus).toHaveBeenCalledWith(expect.anything(), NOW);
    expect(result.corpusRefreshed).toBe(true);
  });

  it('keeps going when one step fails', async () => {
    await seedMailbox(master, { id: 'a1', rampDay: 3, rampUpdatedAt: daysAgo(2) });
    await seedBatch({ from: 'a1', to: 'z', count: 1, sentAt: YESTERDAY_NOON, placement: null });
    vi.mocked(refreshCorpus).mockRejectedValue(new Error('AI Gateway down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await tick();

    expect(result).toMatchObject({ status: 'ok', advanced: 1, corpusRefreshed: false });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('corpus refresh failed'), expect.any(Error));
    error.mockRestore();
  });

  it('does nothing while the kill switch is off', async () => {
    await seedMailbox(master, { id: 'a1', rampDay: 3, rampUpdatedAt: daysAgo(2) });
    await seedBatch({ from: 'a1', to: 'z', count: 1, sentAt: YESTERDAY_NOON, placement: null });

    const result = await tick(testEnv({ FLAGSHIP: flagship(false) }));

    expect(result.status).toBe('disabled');
    expect((await mailbox('a1')).rampDay).toBe(3);
    expect((await mailbox('a1')).stats).toBeNull();
    expect(refreshCorpus).not.toHaveBeenCalled();
    expect(await master.select().from(messages)).toHaveLength(1);
  });

  it('runDaily is the cron entry point and resolves to nothing', async () => {
    await expect(runDaily(testEnv(), { db: master, now: () => NOW })).resolves.toBeUndefined();
  });
});
