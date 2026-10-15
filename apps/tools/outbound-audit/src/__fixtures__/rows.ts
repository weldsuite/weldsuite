/**
 * Fixture rows for the unit tests: one workspace with a cold campaign from a
 * shared-domain mailbox (one template, merge fields, 30 strangers over two
 * days), a few genuine replies and one internal mail. No database involved.
 */

import type { CorrespondentContext, MailboxInfo, SentMessageRow } from '../types';

export const SALES = 'acc_sales';
export const SUPPORT = 'acc_support';

export const MAILBOXES = new Map<string, MailboxInfo>([
  [SALES, { id: SALES, email: 'sales@acme-ws.weldmail.com', sendProvider: 'cloudflare', deleted: false }],
  [SUPPORT, { id: SUPPORT, email: 'support@acme.test', sendProvider: 'cloudflare', deleted: false }],
]);

const FIRST_NAMES = [
  'Anna', 'Bram', 'Carla', 'Daan', 'Emma', 'Femke', 'Gijs', 'Hanna', 'Ivo', 'Jasmijn',
  'Koen', 'Lotte', 'Milan', 'Noor', 'Olaf', 'Puck', 'Quinten', 'Roos', 'Sven', 'Tess',
  'Umar', 'Vera', 'Wout', 'Xena', 'Yara', 'Zeno', 'Abel', 'Bente', 'Cas', 'Dewi',
];
const LAST_NAMES = [
  'Jansen', 'Visser', 'Smit', 'Meijer', 'Bakker', 'Mulder', 'Bos', 'Vos', 'Peters', 'Hendriks',
  'Dekker', 'Brouwer', 'Wouters', 'Kok', 'Vermeulen', 'Prins', 'Postma', 'Kuiper', 'Huisman', 'Willems',
  'Boer', 'Groot', 'Kramer', 'Schouten', 'Hoekstra', 'Maas', 'Verhoeven', 'Koster', 'Blom', 'Jacobs',
];
const COMPANIES = [
  'northwind', 'globex', 'initech', 'umbrella', 'hooli', 'vandelay', 'stark', 'wayne', 'acmecorp', 'cyberdyne',
  'soylent', 'tyrell', 'massive', 'aperture', 'oscorp', 'gringotts', 'monarch', 'paperstreet', 'piedpiper', 'wonka',
  'gekko', 'duff', 'nakatomi', 'oceanic', 'dunder', 'sterling', 'bluth', 'prestige', 'krusty', 'virtucon',
];

export const COLD_RECIPIENTS = FIRST_NAMES.map((first, i) => ({
  email: `${first.toLowerCase()}@${COMPANIES[i]}.com`,
  name: `${first} ${LAST_NAMES[i]}`,
  company: COMPANIES[i].charAt(0).toUpperCase() + COMPANIES[i].slice(1),
  first,
}));

export function coldBody(first: string, company: string): string {
  return [
    `Hi ${first},`,
    '',
    `I came across your company ${company} and noticed you are hiring fast. We help companies like ${company}`,
    'double their pipeline with automated outreach. Would you be open to a quick 15 minute call next week?',
    'You can book a slot here: https://calendly.com/acme-sales/intro',
    '',
    'Best,',
    'Sam',
  ].join('\n');
}

let counter = 0;

export function sentRow(partial: Partial<SentMessageRow>): SentMessageRow {
  counter++;
  return {
    id: `msg_${counter}`,
    accountId: SALES,
    sentAt: new Date('2026-10-10T09:00:00Z'),
    subject: null,
    to: [],
    cc: null,
    bcc: null,
    inReplyTo: null,
    isReply: false,
    isForwarded: false,
    textBody: null,
    htmlBody: null,
    ...partial,
  };
}

/** 26 cold sends on 2026-10-10 (09:00–09:25 UTC) and 4 on 2026-10-11. */
export function coldCampaign(): SentMessageRow[] {
  return COLD_RECIPIENTS.map((r, i) =>
    sentRow({
      accountId: SALES,
      sentAt: i < 26 ? new Date(Date.UTC(2026, 9, 10, 9, i)) : new Date(Date.UTC(2026, 9, 11, 10, i - 26)),
      subject: `Quick question for ${r.company}`,
      to: [{ email: r.email, name: r.name }],
      textBody: coldBody(r.first, r.company),
    }),
  );
}

export const CLIENTS = ['client1@customer.org', 'client2@customer.org', 'client3@customer.org'];

/** Three replies to customers who wrote in on 2026-10-01, one internal mail, one with no recipients. */
export function everydayMail(): SentMessageRow[] {
  return [
    ...CLIENTS.map((email, i) =>
      sentRow({
        accountId: SUPPORT,
        sentAt: new Date(Date.UTC(2026, 9, 11, 14, i)),
        subject: 'Re: meeting',
        to: [{ email, name: `Client ${i + 1}` }],
        inReplyTo: `<thread-${i}@customer.org>`,
        isReply: true,
        textBody: 'Thanks, Tuesday works for us. See you then.',
      }),
    ),
    sentRow({
      accountId: SUPPORT,
      sentAt: new Date(Date.UTC(2026, 9, 11, 15, 0)),
      subject: 'Quarterly planning notes',
      to: [{ email: 'colleague@acme.test', name: 'Colleague' }],
      cc: [{ email: 'Sales@Acme-WS.weldmail.com' }],
      textBody:
        'Here are the notes from the quarterly planning session, including the hiring plan, the budget for the new office and the roadmap for the next two quarters.',
    }),
    sentRow({ accountId: SUPPORT, sentAt: new Date(Date.UTC(2026, 9, 11, 16, 0)), subject: 'draft-like', to: [] }),
  ];
}

/** Who wrote in: the three customers before, two cold recipients after the campaign. */
export function correspondents(): CorrespondentContext {
  const firstInbound = new Map<string, Date>();
  for (const email of CLIENTS) firstInbound.set(email, new Date('2026-10-01T08:00:00Z'));
  firstInbound.set(COLD_RECIPIENTS[0].email, new Date('2026-10-12T08:00:00Z'));
  firstInbound.set(COLD_RECIPIENTS[1].email, new Date('2026-10-12T09:00:00Z'));
  return {
    firstInbound,
    ownAddresses: new Set([...MAILBOXES.values()].map((m) => m.email)),
    ownDomains: new Set(['acme.test']),
  };
}

export function allRecipientAddresses(): string[] {
  return [...COLD_RECIPIENTS.map((r) => r.email), ...CLIENTS, 'colleague@acme.test'];
}
