import { describe, expect, it } from 'vitest';
import { estimateTrustLevel, evaluateProposedLimits, hasOverruns, messagesOver } from './limits';
import { MailAccumulator } from './mail-aggregate';
import { MAILBOXES, SALES, coldCampaign, correspondents, everydayMail, sentRow } from './__fixtures__/rows';

const NOW = new Date('2026-10-13T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

describe('estimateTrustLevel', () => {
  it('keeps young or unpaid workspaces at new', () => {
    expect(estimateTrustLevel({ createdAt: daysAgo(5), subscriptionStatus: 'active', planPriceMonthly: 29, compGranted: false }, NOW)).toBe('new');
    expect(estimateTrustLevel({ createdAt: daysAgo(100), subscriptionStatus: null, planPriceMonthly: null, compGranted: false }, NOW)).toBe('new');
    expect(estimateTrustLevel({ createdAt: daysAgo(100), subscriptionStatus: 'active', planPriceMonthly: 0, compGranted: false }, NOW)).toBe('new');
  });

  it('gives paid (or comp) workspaces past 14 days standard, never trusted without bounce data', () => {
    expect(estimateTrustLevel({ createdAt: daysAgo(100), subscriptionStatus: 'active', planPriceMonthly: 29, compGranted: false }, NOW)).toBe('standard');
    expect(estimateTrustLevel({ createdAt: daysAgo(400), subscriptionStatus: null, planPriceMonthly: null, compGranted: true }, NOW)).toBe('standard');
  });
});

describe('messagesOver', () => {
  it('sums the histogram buckets above a cap', () => {
    const histogram = { '1': 10, '2-5': 4, '6-10': 3, '11-20': 2, '21-50': 1, '51+': 1 };
    expect(messagesOver(histogram, 50)).toBe(1);
    expect(messagesOver(histogram, 20)).toBe(2);
    expect(messagesOver(histogram, 10)).toBe(4);
  });
});

describe('evaluateProposedLimits', () => {
  it('reports the days, mailbox-days and messages that would have hit the new-workspace limits', () => {
    const acc = new MailAccumulator(correspondents(), MAILBOXES, { topTemplates: 5, topDomains: 5 });
    for (const row of [...coldCampaign(), ...everydayMail()]) acc.add(row);
    acc.add(
      sentRow({
        accountId: SALES,
        sentAt: new Date('2026-10-12T08:00:00Z'),
        subject: 'Newsletter',
        to: Array.from({ length: 25 }, (_, i) => ({ email: `reader${i}@list.example` })),
        textBody: 'Monthly update',
      }),
    );
    const mail = acc.finish();

    const overruns = evaluateProposedLimits(mail, [{ day: '2026-10-12', sent: 400, failed: 0 }], 'new');
    expect(overruns.limits).toMatchObject({ workspacePerDay: 300, firstContactPerDay: 50, senderPerDay: 150, senderPerHour: 30, recipientsPerMessage: 20 });
    // 25 newsletter recipients + 400 WeldConnect sends on one day.
    expect(overruns.workspaceDays).toEqual([{ day: '2026-10-12', value: 425 }]);
    expect(overruns.firstContactDays).toEqual([]);
    expect(overruns.mailboxDays).toEqual([]);
    expect(overruns.mailboxHours).toEqual([]);
    expect(overruns.messagesOverRecipientCap).toBe(1);
    // A *.weldmail.com sender reached 26 strangers in one day (cap 20); 25 more on the 12th.
    expect(overruns.sharedDomainFirstContactDays).toEqual([
      { day: '2026-10-10', mailbox: 'sales@acme-ws.weldmail.com', value: 26 },
      { day: '2026-10-12', mailbox: 'sales@acme-ws.weldmail.com', value: 25 },
    ]);
    expect(hasOverruns(overruns)).toBe(true);
  });

  it('finds nothing for quiet traffic under standard limits', () => {
    const acc = new MailAccumulator(correspondents(), MAILBOXES, { topTemplates: 5, topDomains: 5 });
    for (const row of everydayMail()) acc.add(row);
    const overruns = evaluateProposedLimits(acc.finish(), [], 'standard');
    expect(hasOverruns(overruns)).toBe(false);
  });

  it('works without WeldMail data', () => {
    const overruns = evaluateProposedLimits(null, [{ day: '2026-10-12', sent: 2_500, failed: 0 }], 'standard');
    expect(overruns.workspaceDays).toEqual([{ day: '2026-10-12', value: 2_500 }]);
    expect(overruns.messagesOverRecipientCap).toBe(0);
  });
});
