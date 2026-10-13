import { describe, expect, it } from 'vitest';
import type { ReachMailbox } from '@weldsuite/app-api-client/schemas/reach';
import {
  averageInboxPlacement,
  isInWarmupPool,
  showsWarmupFigures,
  warmupBlockerSeverity,
  warmupCopyParams,
  warmupFigures,
  warmupStateToShow,
} from './warmup';

type Figures = Pick<ReachMailbox, 'status' | 'warmupStatus' | 'warmupInboxRate'>;

const mailbox = (overrides: Partial<Figures> = {}): Figures => ({
  status: 'active',
  warmupStatus: 'maintaining',
  warmupInboxRate: 0.9,
  ...overrides,
});

describe('warmupCopyParams', () => {
  it('gives the days, the inbox rate as a whole percentage and the pool minimum', () => {
    expect(warmupCopyParams()).toEqual({ days: 14, rate: 85, domains: 3 });
  });
});

describe('warmupFigures', () => {
  it('passes the numbers through', () => {
    expect(
      warmupFigures({ warmupInboxRate: 0.92, warmupSent7d: 24, warmupSpamRescues7d: 2, warmupBlocker: 'low_inbox_rate' }),
    ).toEqual({ inboxRate: 0.92, sent7d: 24, spamRescues7d: 2, blocker: 'low_inbox_rate' });
  });

  it('reads figures an older API leaves out as no data', () => {
    const olderApi = {} as Pick<ReachMailbox, 'warmupInboxRate' | 'warmupSent7d' | 'warmupSpamRescues7d' | 'warmupBlocker'>;
    expect(warmupFigures(olderApi)).toEqual({ inboxRate: null, sent7d: 0, spamRescues7d: 0, blocker: null });
  });
});

describe('warmupBlockerSeverity', () => {
  it.each([
    ['pool_too_small', 'info'],
    ['too_early', 'info'],
    ['not_enough_data', 'info'],
    ['low_inbox_rate', 'warning'],
    ['login_error', 'warning'],
  ] as const)('%s is %s', (blocker, severity) => {
    expect(warmupBlockerSeverity(blocker)).toBe(severity);
  });
});

describe('isInWarmupPool / showsWarmupFigures', () => {
  it('shows figures for warming and ready mailboxes even before the pool knows them', () => {
    expect(showsWarmupFigures(mailbox({ status: 'warming', warmupStatus: null }))).toBe(true);
    expect(showsWarmupFigures(mailbox({ status: 'active', warmupStatus: null }))).toBe(true);
  });

  it('shows figures for a paused mailbox that is still in the pool, not for one taken out of it', () => {
    expect(showsWarmupFigures(mailbox({ status: 'paused', warmupStatus: 'paused' }))).toBe(true);
    expect(showsWarmupFigures(mailbox({ status: 'paused', warmupStatus: 'removed' }))).toBe(false);
    expect(showsWarmupFigures(mailbox({ status: 'deleting', warmupStatus: null }))).toBe(false);
  });

  it('treats a removed row as not in the pool', () => {
    expect(isInWarmupPool({ warmupStatus: 'removed' })).toBe(false);
    expect(isInWarmupPool({ warmupStatus: null })).toBe(false);
    expect(isInWarmupPool({ warmupStatus: 'waiting' })).toBe(true);
  });
});

describe('warmupStateToShow', () => {
  it('names the states the status badge and the day counter do not', () => {
    expect(warmupStateToShow(mailbox({ status: 'warming', warmupStatus: 'waiting' }))).toBe('waiting');
    expect(warmupStateToShow(mailbox({ status: 'active', warmupStatus: 'maintaining' }))).toBe('maintaining');
    expect(warmupStateToShow(mailbox({ status: 'error', warmupStatus: 'error' }))).toBe('error');
  });

  it('stays quiet while warming (the day counter says it) and when a paused badge already shows', () => {
    expect(warmupStateToShow(mailbox({ status: 'warming', warmupStatus: 'warming' }))).toBeNull();
    expect(warmupStateToShow(mailbox({ status: 'paused', warmupStatus: 'paused' }))).toBeNull();
    expect(warmupStateToShow(mailbox({ status: 'active', warmupStatus: 'paused' }))).toBe('paused');
    expect(warmupStateToShow(mailbox({ status: 'active', warmupStatus: null }))).toBeNull();
  });
});

describe('averageInboxPlacement', () => {
  it('averages warming and ready mailboxes that have a rate', () => {
    const average = averageInboxPlacement([
      mailbox({ status: 'active', warmupInboxRate: 0.9 }),
      mailbox({ status: 'warming', warmupInboxRate: 0.8 }),
    ]);
    expect(average).toBeCloseTo(0.85);
  });

  it('ignores mailboxes without a rate and mailboxes that are not warming or ready', () => {
    const average = averageInboxPlacement([
      mailbox({ status: 'active', warmupInboxRate: 0.9 }),
      mailbox({ status: 'warming', warmupInboxRate: null }),
      mailbox({ status: 'paused', warmupInboxRate: 0.1 }),
      mailbox({ status: 'error', warmupInboxRate: 0.2 }),
    ]);
    expect(average).toBeCloseTo(0.9);
  });

  it('is null when nothing has enough data yet', () => {
    expect(averageInboxPlacement([])).toBeNull();
    expect(averageInboxPlacement([mailbox({ warmupInboxRate: null })])).toBeNull();
  });
});
