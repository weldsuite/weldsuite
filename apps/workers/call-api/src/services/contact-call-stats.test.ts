import { describe, it, expect } from 'vitest';
import { aggregateContactCallStats, type StatsCall } from './contact-call-stats';

function call(overrides: Partial<StatsCall>): StatsCall {
  return {
    contactId: null,
    direction: 'outbound',
    fromNumber: '+31201234567',
    toNumber: '+31612345678',
    duration: 60,
    initiatedAt: new Date('2026-10-01T10:00:00Z'),
    ...overrides,
  };
}

describe('aggregateContactCallStats', () => {
  const anna = { id: 'per_anna', phones: ['06 12 34 56 78'] };
  const bob = { id: 'per_bob', phones: ['+32 475 11 22 33'] };

  it('counts linked calls and unlinked calls whose other party matches a phone', () => {
    const [stats] = aggregateContactCallStats([anna], [
      call({ contactId: 'per_anna', direction: 'inbound', fromNumber: '+31699999999', toNumber: '+31201234567', duration: 30 }),
      call({ toNumber: '+31612345678', duration: 90, initiatedAt: new Date('2026-10-05T09:00:00Z') }),
      call({ direction: 'inbound', fromNumber: '+31612345678', toNumber: '+31201234567', duration: null }),
    ]);

    expect(stats).toEqual({
      contactId: 'per_anna',
      totalCalls: 3,
      inboundCalls: 2,
      outboundCalls: 1,
      totalDuration: 120,
      lastCallAt: '2026-10-05T09:00:00.000Z',
    });
  });

  it('matches the other party, not our own number', () => {
    // Inbound from someone else to a workspace number that happens to equal Anna's.
    const [stats] = aggregateContactCallStats([anna], [
      call({ direction: 'inbound', fromNumber: '+31687654321', toNumber: '+31612345678' }),
    ]);
    expect(stats!.totalCalls).toBe(0);
  });

  it('does not count a call linked to someone else by number', () => {
    const [stats] = aggregateContactCallStats([anna], [
      call({ contactId: 'per_other', toNumber: '+31612345678' }),
    ]);
    expect(stats!.totalCalls).toBe(0);
  });

  it('returns zeroes for a person without calls or phones, keeping the order asked', () => {
    const result = aggregateContactCallStats([{ id: 'per_none', phones: [] }, bob], [
      call({ toNumber: '0032475112233' }),
    ]);
    expect(result.map((s) => [s.contactId, s.totalCalls, s.lastCallAt === null])).toEqual([
      ['per_none', 0, true],
      ['per_bob', 1, false],
    ]);
  });
});
