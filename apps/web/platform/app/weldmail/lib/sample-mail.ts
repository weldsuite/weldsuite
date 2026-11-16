/**
 * Sample mail for designing WeldMail without a filled mailbox (development
 * builds only). Turn it on with `?sampleMail=1` on any WeldMail URL; the choice
 * is remembered in this browser until `?sampleMail=0`. While it is on, the
 * thread lists, the open message, its thread and its attachments come from the
 * conversations below instead of the API, attached to your first mail account.
 * Nothing is sent or stored.
 */
import type { MailThreadSummary, MailThreadListMessageRow } from '@weldsuite/app-api-client/domains/mail-labels';
import type { MailMessageRow, MailMessageWithAttachments, MailThread } from '@weldsuite/app-api-client/domains/mail-messages';
import type { MailAttachmentRow } from '@weldsuite/app-api-client/domains/mail-attachments';
import type { DataResponse } from '@weldsuite/app-api-client';
import type { MailLabelThreadsResponse } from './mail-label-threads-query';
import { getSystemLabelConfig } from './label-config';

const STORAGE_KEY = 'weldmail:sampleMail';

/** Whether sample mail replaces the API (dev builds, after `?sampleMail=1`). */
export function isSampleMailMode(): boolean {
  if (!import.meta.env.DEV || typeof window === 'undefined') return false;
  try {
    const flag = new URLSearchParams(window.location.search).get('sampleMail');
    if (flag === '1') window.localStorage.setItem(STORAGE_KEY, '1');
    if (flag === '0') window.localStorage.removeItem(STORAGE_KEY);
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Ids of sample messages start with this, so the hooks can tell them apart. */
export const SAMPLE_MESSAGE_PREFIX = 'sample_msg_';

export function isSampleMessageId(id: string | undefined | null): boolean {
  return !!id && id.startsWith(SAMPLE_MESSAGE_PREFIX);
}

// ---------------------------------------------------------------------------
// The conversations
// ---------------------------------------------------------------------------

type Person = readonly [name: string, email: string];

/** `null` as sender means the mailbox owner (you). */
interface SampleMessage {
  from: Person | null;
  to?: Person[];
  minutesAgo: number;
  text: string;
  read?: boolean;
  starred?: boolean;
  attachments?: Array<readonly [fileName: string, contentType: string, size: number]>;
}

interface SampleConversation {
  subject: string;
  labels: string[];
  messages: SampleMessage[];
}

const H = 60;
const D = 24 * H;

const ACME: Person = ['Marieke van Dijk', 'marieke@acme-industries.nl'];
const SANNE: Person = ['Sanne Bakker', 'sanne@weldhost.com'];
const TOM: Person = ['Tom Hendriks', 'tom@weldhost.com'];
const JEROEN: Person = ['Jeroen de Vries', 'jeroen@bakkerlogistics.nl'];
const LISA: Person = ['Lisa Jansen', 'lisa@jansen-accountants.nl'];
const MARK: Person = ['Mark Peters', 'mark@northwind.io'];
const FLEUR: Person = ['Fleur de Jong', 'fleur.dejong@gmail.com'];
const EMMA: Person = ['Emma Visser', 'emma.visser@outlook.com'];
const PIETER: Person = ['Pieter Smit', 'pieter.smit@acme-industries.nl'];
const ANOUK: Person = ['Anouk Willems', 'anouk@northwind.io'];
const RUBEN: Person = ['Ruben Mulder', 'ruben@weldhost.com'];
const NOOR: Person = ['Noor Hassan', 'noor@weldhost.com'];

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const CONVERSATIONS: SampleConversation[] = [
  {
    subject: 'Q4 order: revised quote',
    labels: ['INBOX', 'Customers'],
    messages: [
      { from: ACME, minutesAgo: 9 * D + 2 * H, read: true, text: 'Hi Daniel,\n\nWe are planning our Q4 purchasing and would like a quote for 800 units of the WS-200 mounting bracket, delivered to our warehouse in Rotterdam.\n\nCould you include transport costs?\n\nKind regards,\nMarieke van Dijk\nPurchasing, Acme Industries' },
      { from: null, to: [ACME], minutesAgo: 9 * D, read: true, text: 'Hi Marieke,\n\nThanks for thinking of us. Do you need the powder-coated or the galvanised version? I will send the quote tomorrow.\n\nBest,\nDaniel' },
      { from: ACME, minutesAgo: 8 * D + 22 * H, read: true, text: 'Galvanised, please. Same packaging as last year: 40 units per box, boxes on euro pallets.\n\nMarieke' },
      { from: null, to: [ACME], minutesAgo: 8 * D + 3 * H, read: true, text: 'Hi Marieke,\n\nAttached is the quote for 800 galvanised WS-200 brackets, including transport to Rotterdam. Delivery is possible from week 46.\n\nBest,\nDaniel', attachments: [['Quote-Q4-2026.pdf', PDF, 176_128]] },
      { from: ACME, minutesAgo: 7 * D + 5 * H, read: true, text: 'Thanks Daniel. Our finance team asks whether payment within 60 days is possible.\n\nMarieke' },
      { from: null, to: [ACME], minutesAgo: 7 * D + 1 * H, read: true, text: 'We normally work with 30 days, but for an order of this size 45 days is fine.\n\nDaniel' },
      { from: ACME, minutesAgo: 6 * D + 4 * H, read: true, text: '45 days works for us. One more thing: could you send the datasheet and the latest test certificate? Our quality team needs them before we can order.\n\nMarieke' },
      { from: null, to: [ACME], minutesAgo: 6 * D + 2 * H, read: true, text: 'Of course, both are attached.\n\nDaniel', attachments: [['WS-200-datasheet.pdf', PDF, 421_888], ['Test-certificate-EN1090.pdf', PDF, 133_120]] },
      { from: PIETER, minutesAgo: 5 * D + 6 * H, read: true, text: 'Hi Daniel,\n\nPieter from quality at Acme here. The certificate you sent is for batch 2025-41. Will the Q4 order come from a newer batch?\n\nRegards,\nPieter Smit' },
      { from: null, to: [PIETER, ACME], minutesAgo: 5 * D + 3 * H, read: true, text: 'Hi Pieter,\n\nYes, the order will be produced in week 46. You will get the certificate for that batch with the delivery.\n\nBest,\nDaniel' },
      { from: PIETER, minutesAgo: 5 * D + 1 * H, read: true, text: 'Clear, thanks. Quality has no further questions.\n\nPieter' },
      { from: ACME, minutesAgo: 2 * D + 3 * H, read: true, text: 'Hi,\n\nThanks for the quick turnaround on the first quote. Could you revise it for 1,200 units instead of 800, with delivery split over November and December?\n\nKind regards,\nMarieke van Dijk\nPurchasing, Acme Industries' },
      { from: null, to: [ACME], minutesAgo: 2 * D, read: true, text: 'Hi Marieke,\n\nOf course. Attached is the revised quote for 1,200 units in two deliveries. The unit price drops to €18.40 at this volume.\n\nLet me know if you want to go ahead.\n\nBest,\nDaniel', attachments: [['Quote-Q4-2026-rev2.pdf', 'application/pdf', 184_320]] },
      { from: ACME, minutesAgo: 1 * D + 20 * H, read: true, text: 'Thanks Daniel, that looks right. I have passed it to our director for sign-off. You will hear from me tomorrow.\n\nMarieke' },
      { from: null, to: [ACME], minutesAgo: 1 * D + 19 * H, read: true, text: 'Great, thanks for the update.\n\nDaniel' },
      { from: ACME, minutesAgo: 1 * D + 1 * H, read: true, text: 'Small delay: our director is travelling until tomorrow, so the sign-off takes one more day. Sorry about that.\n\nMarieke' },
      { from: ACME, minutesAgo: 12, starred: true, text: 'Hi Daniel,\n\nThe revised quote looks good. We would like to confirm the order, but can the first delivery move to 24 November? Our warehouse is closed the week before.\n\nI have attached our purchase order.\n\nKind regards,\nMarieke', attachments: [['PO-88213.pdf', 'application/pdf', 96_256]] },
    ],
  },
  {
    subject: 'Design review moved to Thursday',
    labels: ['INBOX'],
    messages: [
      { from: SANNE, minutesAgo: 38, text: 'Hey,\n\nQuick heads-up: the design review for the new onboarding flow moves from Wednesday to Thursday 14:00. Same room, same agenda.\n\nCould you bring the latest mobile screens?\n\nThanks!\nSanne' },
    ],
  },
  {
    subject: 'Your invoice from Stripe is ready',
    labels: ['INBOX', 'Invoices'],
    messages: [
      { from: ['Stripe', 'invoice+statements@stripe.com'], minutesAgo: 3 * H, text: 'Your invoice for November 2026 is ready.\n\nAmount due: €249.00\nDue date: 1 December 2026\n\nYou can download the invoice as a PDF from your Stripe dashboard or use the attachment in this email.', attachments: [['Invoice-STR-2026-11.pdf', 'application/pdf', 52_480]] },
    ],
  },
  {
    subject: 'Delivery schedule week 47',
    labels: ['INBOX', 'Customers'],
    messages: [
      { from: JEROEN, minutesAgo: 1 * D + 5 * H, read: true, text: 'Hi Daniel,\n\nCan you confirm the pick-up times for week 47? We have a driver available on Tuesday and Thursday morning.\n\nGroet,\nJeroen' },
      { from: null, to: [JEROEN], minutesAgo: 1 * D + 2 * H, read: true, text: 'Hi Jeroen,\n\nTuesday 08:30 and Thursday 09:00 both work for us. The pallets will be ready at dock 3.\n\nThanks,\nDaniel' },
      { from: JEROEN, minutesAgo: 5 * H, read: true, text: 'Perfect, both are booked. The driver will call 15 minutes before arrival.\n\nJeroen' },
    ],
  },
  {
    subject: 'VAT return Q3: documents needed',
    labels: ['INBOX', 'Follow up'],
    messages: [
      { from: LISA, minutesAgo: 7 * H, starred: true, text: 'Hi Daniel,\n\nTo file the Q3 VAT return before the deadline, I still need:\n\n• the bank statements for September\n• the purchase invoices from Cloudflare and KPN\n• the credit note you sent to Acme in August\n\nCould you upload them by Friday?\n\nKind regards,\nLisa Jansen\nJansen Accountants' },
    ],
  },
  {
    subject: 'Partnership proposal',
    labels: ['INBOX'],
    messages: [
      { from: MARK, minutesAgo: 6 * D, read: true, text: 'Hi Daniel,\n\nWe met at the SaaS meetup in Utrecht. I think there is a good fit between Northwind and WeldSuite: our customers keep asking for a proper helpdesk.\n\nWould you be open to a short call next week?\n\nMark' },
      { from: null, to: [MARK], minutesAgo: 5 * D + 20 * H, read: true, text: 'Hi Mark,\n\nGood to hear from you. Yes, let us talk. Does Tuesday at 11:00 work?\n\nDaniel' },
      { from: MARK, minutesAgo: 5 * D + 18 * H, read: true, text: 'Tuesday 11:00 works. I will send an invite.\n\nMark' },
      { from: ANOUK, minutesAgo: 5 * D + 2 * H, read: true, text: 'Hi Daniel,\n\nI am Anouk, I lead partnerships at Northwind. Mark asked me to join the call on Tuesday. Could you share a short deck about WeldDesk beforehand?\n\nThanks,\nAnouk Willems' },
      { from: null, to: [ANOUK, MARK], minutesAgo: 4 * D + 22 * H, read: true, text: 'Hi Anouk,\n\nNice to meet you. Attached is our partner deck. Slides 5 to 8 are about WeldDesk.\n\nBest,\nDaniel', attachments: [['WeldSuite-partner-deck.pdf', PDF, 3_145_728]] },
      { from: ANOUK, minutesAgo: 4 * D + 20 * H, read: true, text: 'Thanks, very clear. Slide 7 answers most of our questions already.\n\nAnouk' },
      { from: MARK, minutesAgo: 4 * D + 3 * H, read: true, text: 'Agenda for Tuesday:\n\n1. Who our customers are\n2. How WeldDesk fits next to our product\n3. Commercial model\n4. Next steps\n\nAnything to add?\n\nMark' },
      { from: null, to: [MARK, ANOUK], minutesAgo: 4 * D + 1 * H, read: true, text: 'Looks good. I will bring Sanne from our product team, she can show the helpdesk live.\n\nDaniel' },
      { from: SANNE, minutesAgo: 3 * D + 23 * H, read: true, text: 'Hi all,\n\nLooking forward to it. Mark, do you know how many of your customers run their own helpdesk today, and on what?\n\nSanne' },
      { from: MARK, minutesAgo: 3 * D + 20 * H, read: true, text: 'About 60 of our 220 customers. Most of them use Zendesk or a shared inbox in Outlook.\n\nMark' },
      { from: null, to: [MARK, ANOUK], minutesAgo: 3 * D + 5 * H, read: true, text: 'Thanks for the call today, everyone. My notes:\n\n• Northwind offers WeldDesk to its customers as an add-on\n• We start with a pilot for 20 customers in January\n• Northwind sends a first draft of the terms\n\nLet me know if I missed anything.\n\nDaniel' },
      { from: ANOUK, minutesAgo: 3 * D + 4 * H, read: true, text: 'Thanks Daniel. One correction: we would like to start the pilot with 10 customers, not 20.\n\nAnouk' },
      { from: null, to: [ANOUK, MARK], minutesAgo: 3 * D + 3 * H, read: true, text: 'Noted, 10 it is.\n\nDaniel' },
      { from: MARK, minutesAgo: 2 * D + 6 * H, read: true, text: 'Our legal team asks whether WeldSuite stores customer data in the EU. Could you confirm?\n\nMark' },
      { from: null, to: [MARK], minutesAgo: 2 * D + 4 * H, read: true, text: 'Yes, all customer data stays in the EU. Our data processing agreement is attached, section 4 covers where data is stored.\n\nDaniel', attachments: [['WeldSuite-DPA-2026.pdf', PDF, 287_744]] },
      { from: MARK, minutesAgo: 1 * D + 7 * H, read: true, text: 'Legal is happy with it. The draft terms follow tomorrow.\n\nMark' },
      { from: ANOUK, minutesAgo: 1 * D + 1 * H, read: true, text: 'Quick question before we finish the draft: should the revenue share be per seat or per workspace?\n\nAnouk' },
      { from: null, to: [ANOUK, MARK], minutesAgo: 23 * H, read: true, text: 'Per workspace keeps it simple for both of us. Seats change every month.\n\nDaniel' },
      { from: MARK, minutesAgo: 9 * H, text: 'Hi Daniel,\n\nThanks again for the call. As promised, attached is a first draft of the partnership terms. The revenue share is on page 3.\n\nLooking forward to your thoughts.\n\nMark', attachments: [['Northwind-WeldSuite-partnership-draft.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 241_664]] },
    ],
  },
  {
    subject: "Can't log in after password reset",
    labels: ['INBOX', 'Follow up'],
    messages: [
      { from: FLEUR, minutesAgo: 55, text: 'Hello,\n\nI reset my password this morning, but now the login page keeps saying my account is locked. I have a client presentation at 15:00 and need my files.\n\nCan you help?\n\nFleur de Jong' },
    ],
  },
  {
    subject: 'Application: Senior Frontend Engineer',
    labels: ['INBOX'],
    messages: [
      { from: EMMA, minutesAgo: 1 * D + 9 * H, read: true, text: 'Dear hiring team,\n\nI would like to apply for the Senior Frontend Engineer role. I have worked with React and TypeScript for seven years, most recently on a design system used by 40 product teams.\n\nMy CV and a short portfolio are attached.\n\nKind regards,\nEmma Visser', attachments: [['Emma-Visser-CV.pdf', 'application/pdf', 312_000], ['Portfolio-2026.pdf', 'application/pdf', 2_480_000]] },
    ],
  },
  {
    subject: 'Security alert: new sign-in on Mac',
    labels: ['INBOX', 'IMPORTANT'],
    messages: [
      { from: ['Google', 'no-reply@accounts.google.com'], minutesAgo: 2 * D + 6 * H, read: true, text: 'A new sign-in to your account was detected on a Mac in Amsterdam, Netherlands.\n\nIf this was you, you do not need to do anything. If not, we will help you secure your account.' },
    ],
  },
  {
    subject: 'Re: Release notes 2.14',
    labels: ['INBOX'],
    messages: [
      { from: TOM, minutesAgo: 3 * D + 6 * H, read: true, text: 'Here is the first draft of the release notes for 2.14. Can you check the WeldMail section?\n\nTom', attachments: [['Release-notes-2.14-draft.docx', DOCX, 48_128]] },
      { from: null, to: [TOM], minutesAgo: 3 * D + 5 * H, read: true, text: 'Looks good. I would mention the new AI writing assistant first, that is the one customers asked for.\n\nDaniel' },
      { from: SANNE, minutesAgo: 3 * D + 4 * H, read: true, text: 'Agree with Daniel. I added two screenshots to the shared folder.\n\nSanne' },
      { from: RUBEN, minutesAgo: 3 * D + 3 * H, read: true, text: 'One thing: the IMAP sync fix is in 2.14 too. It stops duplicate messages in Outlook accounts, worth a line.\n\nRuben' },
      { from: TOM, minutesAgo: 3 * D + 2 * H, read: true, text: 'Added. Ruben, is that all Outlook accounts or only shared mailboxes?\n\nTom' },
      { from: RUBEN, minutesAgo: 3 * D + 1 * H, read: true, text: 'Only shared mailboxes. Personal accounts were never affected.\n\nRuben' },
      { from: NOOR, minutesAgo: 2 * D + 23 * H, read: true, text: 'From support: please mention that labels can have colours again. We had 14 tickets about it last month.\n\nNoor' },
      { from: SANNE, minutesAgo: 2 * D + 22 * H, read: true, text: 'Good one, Noor. I will make a short GIF of the new colour picker.\n\nSanne' },
      { from: TOM, minutesAgo: 2 * D + 21 * H, read: true, text: 'Second draft attached. Changes: AI assistant first, the IMAP fix, label colours.\n\nTom', attachments: [['Release-notes-2.14-v2.docx', DOCX, 51_200]] },
      { from: null, to: [TOM], minutesAgo: 2 * D + 20 * H, read: true, text: 'Better. Can we cut the intro to two sentences? Nobody reads the first paragraph.\n\nDaniel' },
      { from: TOM, minutesAgo: 2 * D + 19 * H, read: true, text: 'Fair. Done.\n\nTom' },
      { from: RUBEN, minutesAgo: 2 * D + 6 * H, read: true, text: 'Heads-up: scheduled send for shared mailboxes slipped to 2.15. Please take it out of the notes.\n\nRuben' },
      { from: TOM, minutesAgo: 2 * D + 5 * H, read: true, text: 'Removed. Thanks for catching it.\n\nTom' },
      { from: NOOR, minutesAgo: 2 * D + 4 * H, read: true, text: 'Do we need a help article for the AI assistant? Customers will ask what happens with their emails.\n\nNoor' },
      { from: null, to: [NOOR], minutesAgo: 2 * D + 3 * H, read: true, text: 'Yes, good idea. Could you write it? I will check the privacy part.\n\nDaniel' },
      { from: NOOR, minutesAgo: 2 * D + 1 * H, read: true, text: 'On it. Draft by tomorrow.\n\nNoor' },
      { from: SANNE, minutesAgo: 1 * D + 23 * H, read: true, text: 'Screenshots and the GIF are in the shared folder. The GIF is 4 MB, is that too big for the newsletter?\n\nSanne' },
      { from: RUBEN, minutesAgo: 1 * D + 22 * H, read: true, text: 'Keep it under 1 MB, otherwise Gmail clips the email.\n\nRuben' },
      { from: SANNE, minutesAgo: 1 * D + 21 * H, read: true, text: 'Done, it is 780 KB now.\n\nSanne', attachments: [['label-colours.gif', 'image/gif', 798_720]] },
      { from: NOOR, minutesAgo: 1 * D + 6 * H, read: true, text: 'Help article draft attached. Daniel, can you check the privacy section?\n\nNoor', attachments: [['AI-writing-assistant-help.docx', DOCX, 36_864]] },
      { from: null, to: [NOOR], minutesAgo: 1 * D + 4 * H, read: true, text: 'Checked. One change: say in the first line that we never use customer emails to train models. The rest is good.\n\nDaniel' },
      { from: NOOR, minutesAgo: 1 * D + 3 * H, read: true, text: 'Updated, thanks.\n\nNoor' },
      { from: TOM, minutesAgo: 1 * D + 1 * H, read: true, text: 'Final version attached. We publish it Thursday at 10:00, together with the release.\n\nTom', attachments: [['Release-notes-2.14-final.pdf', PDF, 214_016]] },
      { from: RUBEN, minutesAgo: 23 * H, read: true, text: '2.14 is tagged and running on test. Production goes out Thursday at 09:00 if nothing breaks.\n\nRuben' },
      { from: SANNE, minutesAgo: 22 * H, read: true, text: 'Can we post about it on LinkedIn the same day? I have a 30-second video of the AI assistant.\n\nSanne' },
      { from: null, to: [SANNE], minutesAgo: 21 * H, read: true, text: 'Yes, go ahead. Tag the WeldSuite page.\n\nDaniel' },
      { from: TOM, minutesAgo: 4 * H, text: '2.14 is live and the release notes are published. Thanks, all!\n\nTom' },
      { from: NOOR, minutesAgo: 2 * H, text: 'First customer reply is in: the AI assistant saved them 20 minutes this morning.\n\nNoor' },
    ],
  },
  {
    subject: 'Invitation: Weekly sync @ Mon 17 Nov 10:00',
    labels: ['INBOX'],
    messages: [
      { from: ['Google Calendar', 'calendar-notification@google.com'], minutesAgo: 4 * D, read: true, text: 'Tom Hendriks has invited you to Weekly sync.\n\nWhen: Monday 17 November 2026, 10:00 to 10:30\nWhere: Meeting room 2 / WeldMeet\n\nGoing? Yes / Maybe / No' },
    ],
  },
  {
    subject: 'Factuur november 2026',
    labels: ['INBOX', 'Invoices'],
    messages: [
      { from: ['KPN Zakelijk', 'factuur@kpn.com'], minutesAgo: 5 * D, read: true, text: 'Beste klant,\n\nUw factuur van november 2026 staat klaar. Het bedrag van €86,40 wordt rond 28 november van uw rekening afgeschreven.\n\nMet vriendelijke groet,\nKPN Zakelijk', attachments: [['KPN-factuur-2026-11.pdf', 'application/pdf', 61_440]] },
    ],
  },
  {
    subject: "What's new in November",
    labels: ['PROMOTIONS', 'Newsletters'],
    messages: [
      { from: ['Notion', 'team@makenotion.com'], minutesAgo: 1 * D + 14 * H, text: 'This month: faster databases, a new calendar view and AI that fills in your tables.\n\nRead the full changelog on our blog.' },
    ],
  },
  {
    subject: 'You were mentioned in "Website redesign"',
    labels: ['INBOX'],
    messages: [
      { from: ['Figma', 'notifications@figma.com'], minutesAgo: 26 * H, read: true, text: 'Sanne Bakker mentioned you in a comment:\n\n"@Daniel can you check the spacing on the pricing cards? I think the gap is 4px too big on mobile."' },
    ],
  },
  {
    subject: 'Order #10432 confirmed',
    labels: ['INBOX'],
    messages: [
      { from: ['Shopify', 'no-reply@shopify.com'], minutesAgo: 8 * D, read: true, text: 'Thanks for your order!\n\nOrder #10432\n2 × Label printer roll, 102 × 152 mm\nTotal: €64.90\n\nWe will email you when it ships.' },
    ],
  },
  {
    subject: 'Your Cloudflare invoice is available',
    labels: ['INBOX', 'Invoices'],
    messages: [
      { from: ['Cloudflare', 'billing@cloudflare.com'], minutesAgo: 9 * D, read: true, text: 'Your invoice for October 2026 is available.\n\nWorkers Paid: $5.00\nR2 storage: $12.37\nTotal: $17.37' },
    ],
  },
  {
    subject: 'Black Friday: 40% off all plans',
    labels: ['PROMOTIONS'],
    messages: [
      { from: ['Canva', 'marketing@canva.com'], minutesAgo: 2 * D + 1 * H, text: 'Our biggest sale of the year starts now. Get 40% off Canva Pro and Teams until 1 December.' },
    ],
  },
  {
    subject: 'Proposal for Bakker Logistics',
    labels: ['SENT'],
    messages: [
      { from: null, to: [JEROEN], minutesAgo: 10 * D, read: true, text: 'Hi Jeroen,\n\nAs discussed, attached is our proposal for moving your helpdesk and invoicing to WeldSuite, including the migration plan.\n\nHappy to walk you through it.\n\nBest,\nDaniel', attachments: [['WeldSuite-proposal-Bakker-Logistics.pdf', 'application/pdf', 905_216]] },
    ],
  },
];

// ---------------------------------------------------------------------------
// Rows in the API's shapes
// ---------------------------------------------------------------------------

interface SampleAccount {
  id: string;
  email: string;
  displayName?: string | null;
}

let account: SampleAccount = { id: 'sample_account', email: 'you@example.com', displayName: 'You' };

/** The mail account the sample conversations belong to (your first one). */
export function setSampleMailAccount(next: SampleAccount | undefined): void {
  if (next) account = next;
}

interface BuiltMessage {
  row: MailMessageRow;
  attachments: MailAttachmentRow[];
}

function htmlFromText(text: string): string {
  const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => `<p>${escape(paragraph).replaceAll('\n', '<br>')}</p>`)
    .join('');
}

function buildMessage(conversation: SampleConversation, threadIndex: number, index: number, now: number): BuiltMessage {
  const message = conversation.messages[index];
  const id = `${SAMPLE_MESSAGE_PREFIX}${threadIndex}_${index}`;
  const date = new Date(now - message.minutesAgo * 60_000).toISOString();
  const mine = message.from === null;
  const from = mine ? { name: account.displayName ?? 'You', email: account.email } : { name: message.from![0], email: message.from![1] };
  const firstOther = conversation.messages.find((m) => m.from !== null)?.from ?? null;
  // What you sent goes to its own recipients, else to the first other person in the thread.
  const sentTo = message.to ?? (firstOther ? [firstOther] : []);
  const to = mine ? sentTo.map(([name, email]) => ({ name, email })) : [{ name: account.displayName ?? 'You', email: account.email }];
  const attachments: MailAttachmentRow[] = (message.attachments ?? []).map(([fileName, contentType, size], a) => ({
    id: `sample_att_${threadIndex}_${index}_${a}`,
    messageId: id,
    fileName,
    contentType,
    size,
    isInline: false,
    contentId: null,
    contentDisposition: 'attachment',
    checksum: null,
    externalAttachmentId: null,
    createdAt: date,
    updatedAt: date,
    deletedAt: null,
  }));
  const labels = mine ? [...new Set(['SENT', ...conversation.labels.filter((l) => l !== 'INBOX')])] : conversation.labels;
  const row: MailMessageRow = {
    id,
    accountId: account.id,
    messageId: `<${id}@sample.weldsuite.org>`,
    threadId: `sample_thread_${threadIndex}`,
    from,
    to,
    cc: [],
    bcc: [],
    replyTo: null,
    subject: index === 0 ? conversation.subject : `Re: ${conversation.subject}`,
    preview: message.text.replaceAll(/\s+/g, ' ').slice(0, 160),
    textBody: message.text,
    htmlBody: htmlFromText(message.text),
    sentDate: date,
    receivedDate: mine ? null : date,
    isRead: mine || !!message.read,
    isStarred: !!message.starred,
    isFlagged: false,
    isImportant: conversation.labels.includes('IMPORTANT'),
    isDraft: false,
    isReply: index > 0,
    hasAttachments: attachments.length > 0,
    attachmentCount: attachments.length,
    priority: 'normal',
    labels,
    sizeBytes: message.text.length + attachments.reduce((sum, a) => sum + a.size, 0),
    scheduledFor: null,
    sendStatus: mine ? 'sent' : null,
    snoozedUntil: null,
    source: 'sample',
    inReplyTo: index > 0 ? `<${SAMPLE_MESSAGE_PREFIX}${threadIndex}_${index - 1}@sample.weldsuite.org>` : null,
    references: null,
    externalMessageId: null,
    createdAt: date,
    updatedAt: date,
    deletedAt: null,
  };
  return { row, attachments };
}

interface BuiltThread {
  conversation: SampleConversation;
  messages: BuiltMessage[];
}

function buildThreads(): BuiltThread[] {
  const now = Date.now();
  return CONVERSATIONS.map((conversation, t) => ({
    conversation,
    messages: conversation.messages.map((_, m) => buildMessage(conversation, t, m, now)),
  }));
}

function toSummary(thread: BuiltThread): MailThreadSummary {
  const rows = thread.messages.map((m) => m.row);
  const latest = rows[rows.length - 1];
  const listRows: MailThreadListMessageRow[] = rows.map(({ textBody: _text, htmlBody: _html, ...rest }) => rest);
  return {
    threadId: latest.threadId ?? latest.id,
    accountId: account.id,
    subject: thread.conversation.subject,
    participants: [...new Set(rows.map((r) => r.from?.name ?? r.from?.email ?? ''))],
    latestMessageId: latest.id,
    latestSender: latest.from?.name ?? latest.from?.email ?? '',
    latestSenderEmail: latest.from?.email ?? '',
    latestSenderAvatarUrl: null,
    latestDate: latest.sentDate,
    preview: latest.preview ?? '',
    messageCount: rows.length,
    unreadCount: rows.filter((r) => !r.isRead).length,
    hasAttachments: rows.some((r) => r.hasAttachments),
    isStarred: rows.some((r) => r.isStarred),
    labels: [...new Set(rows.flatMap((r) => r.labels ?? []))],
    scheduledFor: null,
    sendStatus: latest.sendStatus,
    messages: listRows,
  };
}

const slugify = (value: string) => value.trim().toLowerCase().replaceAll(/\s+/g, '-');

function inLabel(summary: MailThreadSummary, labelSlug: string): boolean {
  const slug = labelSlug.toLowerCase();
  if (slug === 'starred') return summary.isStarred;
  const system = getSystemLabelConfig(slug);
  if (system) return summary.labels.includes(system.systemLabel);
  return summary.labels.some((label) => slugify(label) === slug);
}

/** A page of a label's sample threads, in the `mailLabels.threads()` response shape. */
export async function sampleLabelThreadsPage(params: { labelSlug: string; search?: string }): Promise<MailLabelThreadsResponse> {
  const search = params.search?.trim().toLowerCase();
  const threads = buildThreads()
    .map(toSummary)
    .filter((summary) => inLabel(summary, params.labelSlug))
    .filter((summary) =>
      !search ||
      [summary.subject, summary.preview, summary.latestSender, summary.latestSenderEmail].some((v) => v.toLowerCase().includes(search)),
    )
    .sort((a, b) => (b.latestDate ?? '').localeCompare(a.latestDate ?? ''));
  return { data: { threads, totalCount: threads.length, nextCursor: null } };
}

function findMessage(id: string): { thread: BuiltThread; message: BuiltMessage } | null {
  for (const thread of buildThreads()) {
    const message = thread.messages.find((m) => m.row.id === id);
    if (message) return { thread, message };
  }
  return null;
}

/** `mailMessages.get()` for a sample message. */
export async function sampleMessage(id: string): Promise<DataResponse<MailMessageWithAttachments>> {
  const found = findMessage(id);
  if (!found) throw new Error('Sample message not found');
  return { data: { ...found.message.row, attachments: found.message.attachments } };
}

/** `mailMessages.thread()` for a sample message. */
export async function sampleThread(messageId: string): Promise<DataResponse<MailThread>> {
  const found = findMessage(messageId);
  if (!found) throw new Error('Sample message not found');
  return {
    data: {
      threadId: found.message.row.threadId ?? found.message.row.id,
      messages: found.thread.messages.map((m) => m.row),
    },
  };
}

/** `mailAttachments.listForMessage()` for a sample message. */
export async function sampleAttachments(messageId: string): Promise<DataResponse<MailAttachmentRow[]>> {
  return { data: findMessage(messageId)?.message.attachments ?? [] };
}
