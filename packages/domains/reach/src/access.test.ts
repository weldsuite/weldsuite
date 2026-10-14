import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { WELDREACH_DEFAULT_LIMITS } from '@weldsuite/app-api-client/schemas/reach';
import { BILLING_GRACE_DAYS, buildAccessSummary, getReachUsage, maySend, utcDayStart, utcTomorrow } from './access';
import { resetReach, seedMailbox, seedOutbound } from './testing/reach';
import { resetReachTenant, seedReachDomain } from './testing/account';

const NOW = new Date('2026-10-12T10:00:00Z');
const access = (patch: Partial<Parameters<typeof maySend>[0]> = {}) => ({
  status: 'approved' as const,
  billingStatus: 'active' as const,
  billingStatusAt: null,
  ...patch,
});

describe('maySend', () => {
  it('needs an approved workspace', () => {
    expect(maySend(access(), NOW)).toEqual({ ok: true });
    expect(maySend(access({ status: 'suspended' }), NOW)).toEqual({ ok: false, reason: 'access_suspended' });
    expect(maySend(access({ status: 'requested' }), NOW)).toEqual({ ok: false, reason: 'access_requested' });
  });

  it('stops for a cancelled subscription at once', () => {
    expect(maySend(access({ billingStatus: 'canceled' }), NOW)).toEqual({ ok: false, reason: 'billing_canceled' });
  });

  it('lets a past-due subscription send through the grace period only', () => {
    const since = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
    expect(maySend(access({ billingStatus: 'past_due', billingStatusAt: since(BILLING_GRACE_DAYS - 1) }), NOW)).toEqual({ ok: true });
    expect(maySend(access({ billingStatus: 'past_due', billingStatusAt: since(BILLING_GRACE_DAYS + 1) }), NOW)).toEqual({
      ok: false,
      reason: 'billing_past_due',
    });
    // No timestamp: the grace starts now.
    expect(maySend(access({ billingStatus: 'past_due' }), NOW)).toEqual({ ok: true });
  });
});

describe('utc day boundaries', () => {
  it('starts the day at 00:00 UTC and the next one a day later', () => {
    expect(utcDayStart(NOW).toISOString()).toBe('2026-10-12T00:00:00.000Z');
    expect(utcTomorrow(NOW).toISOString()).toBe('2026-10-13T00:00:00.000Z');
  });
});

describe('usage and the access summary', () => {
  let db: Database;

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
  }, 60_000);

  beforeEach(async () => {
    await resetReach(db);
    await resetReachTenant(db);
    await seedReachDomain(db, { id: 'rdom_test', hostDomainId: 'dom_1', name: 'getacme.com' });
  });

  it('counts domains, live mailboxes and the sends since 00:00 UTC', async () => {
    const live = await seedMailbox(db);
    await seedMailbox(db, { status: 'deleted', deletedAt: NOW });
    await seedOutbound(db, live.id, { sentAt: new Date('2026-10-12T08:00:00Z') });
    await seedOutbound(db, live.id, { sentAt: new Date('2026-10-12T09:00:00Z') });
    await seedOutbound(db, live.id, { sentAt: new Date('2026-10-11T23:00:00Z') });
    await seedOutbound(db, live.id, { sentAt: new Date('2026-10-12T09:30:00Z'), status: 'failed' });

    expect(await getReachUsage(db, NOW)).toEqual({ domains: 1, mailboxes: 1, sendsToday: 2 });
  });

  it('puts status, resolved limits, usage and the kill switch together', async () => {
    const summary = await buildAccessSummary({
      db,
      access: { status: 'approved', limits: { maxDailySends: 50 } },
      sendingEnabled: false,
      now: NOW,
    });

    expect(summary).toMatchObject({
      status: 'approved',
      limits: { ...WELDREACH_DEFAULT_LIMITS, maxDailySends: 50 },
      usage: { domains: 1, mailboxes: 0, sendsToday: 0 },
      sendingEnabled: false,
    });
  });
});
