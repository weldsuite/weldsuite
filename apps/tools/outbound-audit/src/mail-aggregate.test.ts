import { describe, expect, it } from 'vitest';
import { MailAccumulator } from './mail-aggregate';
import {
  COLD_RECIPIENTS,
  MAILBOXES,
  SALES,
  SUPPORT,
  allRecipientAddresses,
  coldCampaign,
  correspondents,
  everydayMail,
} from './__fixtures__/rows';

function summarize() {
  const acc = new MailAccumulator(correspondents(), MAILBOXES, { topTemplates: 10, topDomains: 10 });
  for (const row of [...coldCampaign(), ...everydayMail()]) acc.add(row);
  return acc.finish();
}

describe('MailAccumulator', () => {
  const summary = summarize();

  it('counts messages, envelope recipients, first contacts and kinds', () => {
    expect(summary.totals).toMatchObject({
      messages: 35,
      messagesWithoutRecipients: 1,
      recipients: 35,
      distinctRecipients: 35,
      firstContactRecipients: 30,
      distinctFirstContact: 30,
      newThreads: 31,
      replies: 3,
      forwards: 0,
      activeDays: 2,
      activeMailboxes: 2,
    });
    expect(summary.totals.firstContactShare).toBeCloseTo(30 / 35);
  });

  it('measures how many first contacts wrote back afterwards', () => {
    expect(summary.totals.firstContactRepliedLater).toBe(2);
    expect(summary.totals.firstContactReplyRate).toBeCloseTo(2 / 30);
  });

  it('breaks volume down per mailbox and UTC day, with the peak hour', () => {
    const salesDay1 = summary.mailboxDays.find((d) => d.mailboxId === SALES && d.day === '2026-10-10');
    expect(salesDay1).toMatchObject({
      mailbox: 'sales@acme-ws.weldmail.com',
      messages: 26,
      recipients: 26,
      distinctRecipients: 26,
      recipientDomains: 26,
      firstContactRecipients: 26,
      newThreads: 26,
      peakHourRecipients: 26,
    });
    const supportDay2 = summary.mailboxDays.find((d) => d.mailboxId === SUPPORT && d.day === '2026-10-11');
    expect(supportDay2).toMatchObject({ messages: 4, recipients: 5, firstContactRecipients: 0, replies: 3, newThreads: 1 });

    const sales = summary.mailboxes.find((m) => m.mailboxId === SALES);
    expect(sales).toMatchObject({ sharedDomain: true, messages: 30, activeDays: 2, peakDayRecipients: 26, distinctFirstContact: 30 });
    expect(summary.mailboxes[0].mailboxId).toBe(SALES);
    expect(summary.days.map((d) => [d.day, d.recipients, d.firstContactRecipients])).toEqual([
      ['2026-10-10', 26, 26],
      ['2026-10-11', 9, 4],
    ]);
  });

  it('finds the cold template and its first-contact reach', () => {
    const [top] = summary.templates;
    expect(top).toMatchObject({
      messages: 30,
      distinctRecipients: 30,
      distinctFirstContact: 30,
      peakDayFirstContact: 26,
      days: 2,
      mailboxes: ['sales@acme-ws.weldmail.com'],
      flaggedMessages: 30,
    });
    expect(top.subject).toBe('Quick question for [name]');
    expect(top.snippet.length).toBeLessThanOrEqual(120);
    expect(top.snippet).toContain('tokname');
    expect(summary.totals.templatesTracked).toBe(2);
    expect(summary.totals.templatesOverReviewThreshold).toBe(1);
    expect(summary.totals.templatesOverColdCap).toBe(1);
  });

  it('runs the content screen on every send with recipients', () => {
    expect(summary.content).toMatchObject({ screened: 34, flagged: 30, coldOutreach: 30, phishing: 0 });
    expect(summary.content.reasons.cold_phrases).toBe(30);
    expect(summary.content.reasons.booking_link).toBe(30);
  });

  it('buckets recipients per message and ranks recipient domains', () => {
    expect(summary.recipientsPerMessage).toEqual({ '1': 33, '2-5': 1, '6-10': 0, '11-20': 0, '21-50': 0, '51+': 0 });
    expect(summary.topDomains[0]).toEqual({ domain: 'customer.org', recipients: 3 });
  });

  it('never carries a recipient address or name into the summary', () => {
    const json = JSON.stringify(summary).toLowerCase();
    for (const email of allRecipientAddresses()) expect(json).not.toContain(email);
    for (const r of COLD_RECIPIENTS) {
      expect(json).not.toContain(`"${r.first.toLowerCase()}`);
      expect(json).not.toContain(` ${r.first.toLowerCase()} `);
    }
  });

  it('labels a mailbox it does not know by id', () => {
    const acc = new MailAccumulator(correspondents(), new Map(), { topTemplates: 5, topDomains: 5 });
    acc.add(coldCampaign()[0]);
    expect(acc.finish().mailboxes[0].mailbox).toBe(`unknown mailbox ${SALES}`);
  });
});
