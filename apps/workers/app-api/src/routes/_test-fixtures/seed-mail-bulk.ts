/**
 * Bulk mailbox seed for performance measurements (phase 0 of
 * docs/plans/weldmail-mailbox-storage.md). Fills one mailbox with messages
 * grouped into threads, spread back in time from now, with bodies of a chosen
 * size, so opening mail can be timed on a mailbox the size of a real one.
 *
 * Every row carries the fixtures' marker in `custom_fields.__e2e`, so
 * `POST /test-fixtures/reset` deletes these like any other seeded message.
 */

import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

type MailMessageInsert = typeof schema.mailMessages.$inferInsert;

export interface SeedMailBulkOptions {
  accountId: string;
  accountEmail: string;
  /** Messages to create. */
  count: number;
  /** Messages per thread; the last thread may be shorter. */
  threadSize: number;
  /** Size of each message's text body; the HTML body is the same text in paragraphs. */
  bodyBytes: number;
  /** Share of threads whose messages are unread, 0 to 1. */
  unreadRatio: number;
  /** The newest thread is dated now, the oldest this many days ago. */
  spreadDays: number;
  labels: string[];
  /** The fixtures' reset marker. */
  marker: string;
  now: Date;
  /** Makes Message-IDs unique across seed calls. */
  batch: string;
}

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const SENDERS = 50;
const FILLER =
  'This is a seeded message for timing WeldMail. It has no meaning, only a realistic length so the database and the network carry what a real mailbox would. ';

/** Insert size that keeps one Neon HTTP request around 2 MB whatever the body size. */
export function seedInsertChunkSize(bodyBytes: number): number {
  return Math.max(1, Math.floor(2_000_000 / (bodyBytes * 2 + 1_000)));
}

export function buildSeedMailRows(options: SeedMailBulkOptions): MailMessageInsert[] {
  const { count, threadSize, now } = options;
  const threads = Math.ceil(count / threadSize);
  const textBody = FILLER.repeat(Math.ceil(options.bodyBytes / FILLER.length)).slice(0, options.bodyBytes);
  const htmlBody = textBody ? `<p>${textBody}</p>` : null;
  const unreadEvery = options.unreadRatio > 0 ? Math.max(1, Math.round(1 / options.unreadRatio)) : 0;

  const rows: MailMessageInsert[] = [];
  for (let index = 0; index < count; index++) {
    const thread = Math.floor(index / threadSize);
    const position = index % threadSize;
    const root = `<bulk-${options.batch}-t${thread}@e2e.test>`;
    const messageId = position === 0 ? root : `<bulk-${options.batch}-t${thread}-m${position}@e2e.test>`;
    // Thread 0 is the newest; messages within a thread are a few minutes apart.
    const threadStart = now.getTime() - (thread / Math.max(1, threads - 1)) * options.spreadDays * DAY_MS;
    const date = new Date(Math.min(now.getTime(), threadStart + position * 5 * MINUTE_MS));
    const sender = `sender${thread % SENDERS}@external.test`;

    rows.push({
      id: generateId('msg'),
      accountId: options.accountId,
      messageId,
      threadId: root,
      inReplyTo: position === 0 ? null : root,
      from: { email: sender, name: `Sender ${thread % SENDERS}` },
      to: [{ email: options.accountEmail }],
      subject: position === 0 ? `Seeded thread ${thread}` : `Re: Seeded thread ${thread}`,
      preview: textBody.slice(0, 200),
      textBody,
      htmlBody,
      sentDate: date,
      receivedDate: date,
      isRead: unreadEvery === 0 || thread % unreadEvery !== 0,
      source: 'inbox',
      labels: options.labels,
      customFields: { __e2e: options.marker },
      createdAt: date,
      updatedAt: date,
    } as unknown as MailMessageInsert);
  }
  return rows;
}
