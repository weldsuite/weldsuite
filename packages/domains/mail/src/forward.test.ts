/**
 * pglite-backed tests for forwarding and the stored text of a sent mail
 * (2026-10-04 QA run):
 *
 * - a forward carries the original's attachments, unless the sender removed
 *   them, and "forward as attachment" attaches the original as an .eml
 *   (TASK-901);
 * - the quoted header is HTML-escaped and dated in the sender's time zone
 *   (TASK-901);
 * - the text/plain part and the list preview are tag-free even when a client
 *   sends its editor HTML as `body` (TASK-903).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(public readonly from: string, public readonly to: string, public readonly raw: string) {}
  },
}));

import { forwardAndPersist, MailSendError, sendAndPersist } from './send';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';
import type { MailSendEnv as Env } from './send';

const { mailAccounts, mailMessages, mailAttachments } = schema;

const ORG = 'org_test';
const USER = 'user_test';
const SELF = 'me@test.dev';
const NOTE_BYTES = new TextEncoder().encode('inbound note');

/** In-memory R2: the original's file lives outside the caller's upload prefix, as inbound stores it. */
const stored = new Map<string, { bytes: Uint8Array; contentType?: string }>();
const env = {
  STORAGE: {
    get: async (key: string) => {
      const obj = stored.get(key);
      if (!obj) return null;
      return {
        arrayBuffer: async () => obj.bytes.slice().buffer,
        httpMetadata: { contentType: obj.contentType },
      };
    },
    put: async (key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }) => {
      stored.set(key, { bytes: new Uint8Array(value), contentType: options?.httpMetadata?.contentType });
    },
  },
} as unknown as Env;

let db: Database;

async function seedAccount(): Promise<string> {
  const id = generateId('mail');
  await db.insert(mailAccounts).values({ id, name: 'Test', email: SELF, isShared: true });
  return id;
}

async function seedIncoming(
  accountId: string,
  extra: Partial<typeof mailMessages.$inferInsert> = {},
): Promise<string> {
  const id = generateId('mmsg');
  await db.insert(mailMessages).values({
    id,
    accountId,
    messageId: `<${id}@gmail.com>`,
    from: { email: 'weldhost@gmail.com', name: 'daniel snelderwaard' },
    to: [{ email: SELF, name: 'Team' }],
    subject: '[QA] Inbound 02 <with> attachment',
    textBody: 'See the note.',
    htmlBody: '<p>See the note.</p>',
    sentDate: new Date('2026-10-04T21:05:51Z'),
    hasAttachments: true,
    attachmentCount: 1,
    ...extra,
  });
  return id;
}

async function seedOriginalAttachment(messageId: string, fileName = 'inbound-note.txt'): Promise<string> {
  const id = generateId('attach');
  const storagePath = `workspaces/ws_internal/mail/attachments/${messageId}/1_${fileName}`;
  stored.set(storagePath, { bytes: NOTE_BYTES, contentType: 'text/plain' });
  await db.insert(mailAttachments).values({
    id,
    messageId,
    fileName,
    contentType: 'text/plain',
    size: NOTE_BYTES.byteLength,
    storagePath,
    isInline: false,
  });
  return id;
}

async function sentCopy(messageId: string) {
  const [message] = await db.select().from(mailMessages).where(eq(mailMessages.id, messageId)).limit(1);
  const attachments = await db
    .select()
    .from(mailAttachments)
    .where(eq(mailAttachments.messageId, messageId));
  return { message: message!, attachments };
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

beforeEach(() => stored.clear());

describe('forwardAndPersist (pglite, dryRun)', () => {
  it('carries the original attachments as files of the forwarded copy', async () => {
    const accountId = await seedAccount();
    const original = await seedIncoming(accountId);
    await seedOriginalAttachment(original);

    const result = await forwardAndPersist(
      env, db, ORG, USER, original,
      { to: ['someone@example.com'], body: 'FYI' },
      undefined,
      { dryRun: true },
    );

    const { message, attachments } = await sentCopy(result.messageId);
    expect(message.hasAttachments).toBe(true);
    expect(message.attachmentCount).toBe(1);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.fileName).toBe('inbound-note.txt');
    // A copy of its own, so deleting the original leaves the forward intact.
    expect(attachments[0]!.storagePath).toBe(
      `workspaces/${ORG}/mail/attachments/${result.messageId}/1_inbound-note.txt`,
    );
    expect(stored.get(attachments[0]!.storagePath!)!.bytes).toEqual(NOTE_BYTES);
  });

  it('leaves out the attachments the sender removed', async () => {
    const accountId = await seedAccount();
    const original = await seedIncoming(accountId);
    const removed = await seedOriginalAttachment(original, 'remove-me.txt');
    await seedOriginalAttachment(original, 'keep-me.txt');

    const result = await forwardAndPersist(
      env, db, ORG, USER, original,
      { to: ['someone@example.com'], excludeAttachmentIds: [removed] },
      undefined,
      { dryRun: true },
    );

    const { attachments } = await sentCopy(result.messageId);
    expect(attachments.map((a) => a.fileName)).toEqual(['keep-me.txt']);
  });

  it('escapes the quoted header and dates it in the sender time zone', async () => {
    const accountId = await seedAccount();
    const original = await seedIncoming(accountId, { hasAttachments: false, attachmentCount: 0 });

    const result = await forwardAndPersist(
      env, db, ORG, USER, original,
      { to: ['someone@example.com'], body: 'FYI', timeZone: 'Europe/Amsterdam', locale: 'en-GB' },
      undefined,
      { dryRun: true },
    );

    const { message } = await sentCopy(result.messageId);
    expect(message.subject).toBe('Fwd: [QA] Inbound 02 <with> attachment');
    expect(message.htmlBody).toContain('<b>From:</b> daniel snelderwaard &lt;weldhost@gmail.com&gt;');
    expect(message.htmlBody).toContain('<b>Subject:</b> [QA] Inbound 02 &lt;with&gt; attachment');
    expect(message.htmlBody).toContain('<b>To:</b> Team &lt;me@test.dev&gt;');
    // 21:05 UTC is 23:05 in Amsterdam (CEST); never the raw `Date.toString()`.
    expect(message.htmlBody).toContain('23:05');
    expect(message.htmlBody).not.toContain('Coordinated Universal Time');
    expect(message.textBody).toContain('From: daniel snelderwaard <weldhost@gmail.com>');
    expect(message.textBody?.startsWith('FYI\n\n---------- Forwarded message ----------')).toBe(true);
    expect(message.preview?.startsWith('FYI ---------- Forwarded message')).toBe(true);
  });

  it('falls back to UTC for an unknown time zone', async () => {
    const accountId = await seedAccount();
    const original = await seedIncoming(accountId, { hasAttachments: false, attachmentCount: 0 });

    const result = await forwardAndPersist(
      env, db, ORG, USER, original,
      { to: ['someone@example.com'], timeZone: 'Not/AZone' },
      undefined,
      { dryRun: true },
    );

    const { message } = await sentCopy(result.messageId);
    expect(message.textBody).toMatch(/Date: Sun, Oct 4, 2026(?:,| at) 9:05\sPM UTC/);
  });

  it('"forward as attachment" attaches the raw original as an .eml and quotes nothing', async () => {
    const accountId = await seedAccount();
    const raw = 'From: weldhost@gmail.com\r\nSubject: raw\r\n\r\nbody';
    const original = await seedIncoming(accountId, { rawMessage: raw });
    await seedOriginalAttachment(original);

    const result = await forwardAndPersist(
      env, db, ORG, USER, original,
      { to: ['someone@example.com'], body: 'Original attached', asAttachment: true },
      undefined,
      { dryRun: true },
    );

    const { message, attachments } = await sentCopy(result.messageId);
    expect(message.textBody).toBe('Original attached');
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.fileName).toBe('[QA] Inbound 02 with attachment.eml');
    const eml = new TextDecoder().decode(stored.get(attachments[0]!.storagePath!)!.bytes);
    expect(eml).toBe(raw);
  });

  it('rebuilds the .eml, files included, when no raw message was stored', async () => {
    const accountId = await seedAccount();
    const original = await seedIncoming(accountId);
    await seedOriginalAttachment(original);

    const result = await forwardAndPersist(
      env, db, ORG, USER, original,
      { to: ['someone@example.com'], asAttachment: true },
      undefined,
      { dryRun: true },
    );

    const { attachments } = await sentCopy(result.messageId);
    expect(attachments).toHaveLength(1);
    const eml = new TextDecoder().decode(stored.get(attachments[0]!.storagePath!)!.bytes);
    expect(eml).toContain('weldhost@gmail.com');
    expect(eml).toContain('See the note.');
    expect(eml).toContain('inbound-note.txt');
  });

  it('fails loudly instead of forwarding without a file that is gone from storage', async () => {
    const accountId = await seedAccount();
    const original = await seedIncoming(accountId);
    await seedOriginalAttachment(original);
    stored.clear();

    await expect(
      forwardAndPersist(env, db, ORG, USER, original, { to: ['someone@example.com'] }, undefined, {
        dryRun: true,
      }),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_IN_STORAGE' } satisfies Partial<MailSendError>);
  });
});

describe('sendAndPersist · text/plain part and preview (TASK-903)', () => {
  it('stores tag-free text when the client sends its editor HTML as body', async () => {
    const accountId = await seedAccount();
    const html =
      'Hello from WeldMail QA. Plain line one.<div><b>This sentence is bold.</b></div><div><i>This sentence is italic.</i></div>';

    const result = await sendAndPersist(
      env, db, ORG, USER, accountId,
      { to: ['someone@example.com'], subject: 'Formatting', body: html, htmlBody: html },
      undefined,
      { dryRun: true },
    );

    const { message } = await sentCopy(result.messageId);
    expect(message.textBody).toBe(
      'Hello from WeldMail QA. Plain line one.\nThis sentence is bold.\nThis sentence is italic.',
    );
    expect(message.preview).toBe(
      'Hello from WeldMail QA. Plain line one. This sentence is bold. This sentence is italic.',
    );
    expect(message.htmlBody).toContain('<b>This sentence is bold.</b>');
  });

  it('gives an HTML-only body field a real HTML part', async () => {
    const accountId = await seedAccount();

    const result = await sendAndPersist(
      env, db, ORG, USER, accountId,
      { to: ['someone@example.com'], subject: 'Legacy client', body: '<p>Only <b>body</b></p>' },
      undefined,
      { dryRun: true },
    );

    const { message } = await sentCopy(result.messageId);
    expect(message.textBody).toBe('Only body');
    expect(message.htmlBody).toContain('<b>body</b>');
  });

  it('derives the text part from the HTML when no body is sent', async () => {
    const accountId = await seedAccount();

    const result = await sendAndPersist(
      env, db, ORG, USER, accountId,
      { to: ['someone@example.com'], subject: 'Html only', htmlBody: '<p>First</p><p>Second</p>' },
      undefined,
      { dryRun: true },
    );

    const { message } = await sentCopy(result.messageId);
    expect(message.textBody).toBe('First\nSecond');
    expect(message.preview).toBe('First Second');
  });
});
