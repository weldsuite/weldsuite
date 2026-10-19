/**
 * pglite-backed tests: inline images of outgoing mail (TASK-905 follow-up).
 *
 * The reading pane gets inline images as minted `/public/mail-inline/:token`
 * URLs that expire within the hour. A reply or forward that quotes that HTML
 * must not send those URLs out:
 *
 * - a minted URL becomes a `cid:` reference to an inline MIME part, and the
 *   Sent copy keeps the image as an inline attachment of its own;
 * - an expired token does the same while the attachment still exists;
 * - a tampered or foreign token, a deleted attachment, another workspace's
 *   key or a mailbox the sender cannot open drops the image instead;
 * - a forward's quoted original sends its own `cid:` images inline (they used
 *   to be left out, so the quote pointed at parts that were not there).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(public readonly from: string, public readonly to: string, public readonly raw: string) {}
  },
}));

import { forwardAndPersist, replyAndPersist, sendAndPersist } from './send';
import { embedInlineImages } from './send-inline-images';
import { INLINE_IMAGE_PATH, rewriteInlineImages, sealInlineImageToken, type InlineImageSigner } from './inline-images';
import { buildRfc5322 } from '@weldsuite/email/core/mime';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';
import type { MailSendEnv as Env } from './send';

const { mailAccounts, mailMessages, mailAttachments } = schema;

const ORG = 'org_test';
const USER = 'user_test';
const SELF = 'me@test.dev';
const SECRET = 'inline-test-secret';
const LOGO = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const signer: InlineImageSigner = { workspaceId: ORG, baseUrl: 'https://mail-api.test', secret: SECRET };

const stored = new Map<string, { bytes: Uint8Array; contentType?: string }>();
const env = {
  MAIL_INLINE_IMAGE_SECRET: SECRET,
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

async function seedAccount(extra: Partial<typeof mailAccounts.$inferInsert> = {}): Promise<string> {
  const id = generateId('mail');
  await db.insert(mailAccounts).values({ id, name: 'Test', email: SELF, isShared: true, ...extra });
  return id;
}

/** An inbound message whose HTML shows `logo.png` inline, as inbound stores it since TASK-905. */
async function seedWithInlineImage(accountId: string): Promise<{ messageId: string; attachmentId: string }> {
  const messageId = generateId('mmsg');
  await db.insert(mailMessages).values({
    id: messageId,
    accountId,
    messageId: `<${messageId}@example.com>`,
    from: { email: 'sender@example.com', name: 'Sender' },
    to: [{ email: SELF }],
    subject: 'With a logo',
    textBody: 'Hello',
    htmlBody: '<p>Hello</p><img src="cid:image001.png@01DA" alt="logo">',
    sentDate: new Date('2026-10-18T09:00:00Z'),
    hasAttachments: true,
    attachmentCount: 1,
  });
  const attachmentId = generateId('attach');
  const storagePath = `workspaces/${ORG}/mail/attachments/${messageId}/1_logo.png`;
  stored.set(storagePath, { bytes: LOGO, contentType: 'image/png' });
  await db.insert(mailAttachments).values({
    id: attachmentId,
    messageId,
    fileName: 'logo.png',
    contentType: 'image/png',
    size: LOGO.byteLength,
    storagePath,
    isInline: true,
    contentId: 'image001.png@01DA',
  });
  return { messageId, attachmentId };
}

/** The original's HTML as the reading pane gets it, minted URLs and all. */
async function readingPaneHtml(messageId: string, now?: number): Promise<string> {
  const [message] = await db.select().from(mailMessages).where(eq(mailMessages.id, messageId)).limit(1);
  const refs = await db.select().from(mailAttachments).where(eq(mailAttachments.messageId, messageId));
  const html = await rewriteInlineImages(message!.htmlBody!, refs, { ...signer, now });
  expect(html).toContain(`https://mail-api.test${INLINE_IMAGE_PATH}/`);
  return html;
}

/** A reply that quotes the reading-pane HTML, like the platform composer sends it. */
function quotedReply(readingHtml: string): string {
  return `<p>Thanks!</p><blockquote>${readingHtml}</blockquote>`;
}

async function sentCopy(messageId: string) {
  const [message] = await db.select().from(mailMessages).where(eq(mailMessages.id, messageId)).limit(1);
  const attachments = await db.select().from(mailAttachments).where(eq(mailAttachments.messageId, messageId));
  return { message: message!, attachments };
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

beforeEach(() => stored.clear());

describe('replyAndPersist · quoted inline images (pglite, dryRun)', () => {
  it('sends a quoted minted URL as an inline part and keeps it on the Sent copy', async () => {
    const accountId = await seedAccount();
    const { messageId, attachmentId } = await seedWithInlineImage(accountId);

    const result = await replyAndPersist(
      env, db, ORG, USER, messageId,
      { htmlBody: quotedReply(await readingPaneHtml(messageId)) },
      { dryRun: true },
    );

    const { message, attachments } = await sentCopy(result.messageId);
    const cid = `${attachmentId}@weldmail`;
    expect(message.htmlBody).not.toContain(INLINE_IMAGE_PATH);
    expect(message.htmlBody).toContain(`src="cid:${cid}"`);
    expect(message.hasAttachments).toBe(true);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ fileName: 'logo.png', contentType: 'image/png', isInline: true, contentId: cid });
    // A copy of its own, so the Sent copy keeps the image when the original goes.
    expect(attachments[0]!.storagePath).toMatch(new RegExp(`^workspaces/${ORG}/mail/attachments/${result.messageId}/`));
    expect(stored.get(attachments[0]!.storagePath!)!.bytes).toEqual(LOGO);
  });

  it('embeds the image of an expired token while the attachment still exists', async () => {
    const accountId = await seedAccount();
    const { messageId, attachmentId } = await seedWithInlineImage(accountId);
    const yesterday = Date.now() - 24 * 60 * 60 * 1000;

    const result = await replyAndPersist(
      env, db, ORG, USER, messageId,
      { htmlBody: quotedReply(await readingPaneHtml(messageId, yesterday)) },
      { dryRun: true },
    );

    const { message } = await sentCopy(result.messageId);
    expect(message.htmlBody).toContain(`cid:${attachmentId}@weldmail`);
    expect(message.htmlBody).not.toContain(INLINE_IMAGE_PATH);
  });

  it('drops the image when the attachment was deleted', async () => {
    const accountId = await seedAccount();
    const { messageId, attachmentId } = await seedWithInlineImage(accountId);
    const html = quotedReply(await readingPaneHtml(messageId));
    await db.update(mailAttachments).set({ deletedAt: new Date() }).where(eq(mailAttachments.id, attachmentId));

    const result = await replyAndPersist(env, db, ORG, USER, messageId, { htmlBody: html }, { dryRun: true });

    const { message, attachments } = await sentCopy(result.messageId);
    expect(message.htmlBody).not.toContain(INLINE_IMAGE_PATH);
    expect(message.htmlBody).not.toContain('<img');
    expect(message.htmlBody).toContain('Thanks!');
    expect(attachments).toHaveLength(0);
  });

  it('drops a tampered token', async () => {
    const accountId = await seedAccount();
    const { messageId } = await seedWithInlineImage(accountId);
    const html = (await readingPaneHtml(messageId)).replace(/(mail-inline\/)([A-Za-z0-9_-])/, (_m, p, c) => `${p}${c === 'A' ? 'B' : 'A'}`);

    const result = await replyAndPersist(env, db, ORG, USER, messageId, { htmlBody: quotedReply(html) }, { dryRun: true });

    const { message, attachments } = await sentCopy(result.messageId);
    expect(message.htmlBody).not.toContain(INLINE_IMAGE_PATH);
    expect(message.htmlBody).not.toContain('<img');
    expect(attachments).toHaveLength(0);
  });

  it("drops a token for another workspace's file", async () => {
    const accountId = await seedAccount();
    const { messageId, attachmentId } = await seedWithInlineImage(accountId);
    const foreignKey = `workspaces/org_other/mail/attachments/${messageId}/1_logo.png`;
    stored.set(foreignKey, { bytes: LOGO, contentType: 'image/png' });
    const token = await sealInlineImageToken(SECRET, {
      w: 'org_other',
      a: attachmentId,
      k: foreignKey,
      t: 'image/png',
      e: Math.floor(Date.now() / 1000) + 3600,
    });
    const html = `<img src="https://mail-api.test${INLINE_IMAGE_PATH}/${token}">`;

    const result = await replyAndPersist(env, db, ORG, USER, messageId, { htmlBody: quotedReply(html) }, { dryRun: true });

    const { message, attachments } = await sentCopy(result.messageId);
    expect(message.htmlBody).not.toContain(INLINE_IMAGE_PATH);
    expect(attachments).toHaveLength(0);
  });

  it('drops the image of a mailbox the sender cannot open', async () => {
    const sending = await seedAccount();
    const privateBox = await seedAccount({ isShared: false, assignedUserIds: ['someone_else'] });
    const { messageId } = await seedWithInlineImage(privateBox);
    const html = quotedReply(await readingPaneHtml(messageId));

    const result = await sendAndPersist(
      env, db, ORG, USER, sending,
      { to: ['friend@example.com'], subject: 'Look', htmlBody: html },
      { dryRun: true },
    );

    const { message, attachments } = await sentCopy(result.messageId);
    expect(message.htmlBody).not.toContain(INLINE_IMAGE_PATH);
    expect(message.htmlBody).not.toContain('<img');
    expect(attachments).toHaveLength(0);
  });

  it('leaves HTML without minted URLs alone', async () => {
    const accountId = await seedAccount();
    const html = '<p>Hi</p><img src="https://cdn.example.com/public/logo.png">';

    const result = await sendAndPersist(
      env, db, ORG, USER, accountId,
      { to: ['friend@example.com'], subject: 'Plain', htmlBody: html },
      { dryRun: true },
    );

    const { message, attachments } = await sentCopy(result.messageId);
    expect(message.htmlBody).toContain('https://cdn.example.com/public/logo.png');
    expect(attachments).toHaveLength(0);
  });
});

describe('forwardAndPersist · inline images of the original (pglite, dryRun)', () => {
  it("sends the quoted original's cid: images as inline parts", async () => {
    const accountId = await seedAccount();
    const { messageId, attachmentId } = await seedWithInlineImage(accountId);

    const result = await forwardAndPersist(
      env, db, ORG, USER, messageId,
      { to: ['someone@example.com'], body: 'FYI' },
      { dryRun: true },
    );

    const { message, attachments } = await sentCopy(result.messageId);
    const cid = `${attachmentId}@weldmail`;
    expect(message.htmlBody).toContain(`src="cid:${cid}"`);
    expect(message.htmlBody).not.toContain('cid:image001.png@01DA');
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ isInline: true, contentId: cid, fileName: 'logo.png' });
  });

  it('also embeds minted URLs in the note above the quote', async () => {
    const accountId = await seedAccount();
    const { messageId, attachmentId } = await seedWithInlineImage(accountId);

    const result = await forwardAndPersist(
      env, db, ORG, USER, messageId,
      { to: ['someone@example.com'], htmlBody: `<p>See:</p>${await readingPaneHtml(messageId)}` },
      { dryRun: true },
    );

    const { message, attachments } = await sentCopy(result.messageId);
    expect(message.htmlBody).not.toContain(INLINE_IMAGE_PATH);
    // One image, one part, however many times it is referenced.
    expect(message.htmlBody!.split(`cid:${attachmentId}@weldmail`).length - 1).toBe(2);
    expect(attachments).toHaveLength(1);
  });
});

describe('embedInlineImages', () => {
  it('yields parts the MIME builder sends as multipart/related with their Content-ID', async () => {
    const accountId = await seedAccount();
    const { messageId, attachmentId } = await seedWithInlineImage(accountId);

    const { html, parts } = await embedInlineImages(env, db, await readingPaneHtml(messageId), {
      workspaceId: ORG,
      caller: USER,
      accountId,
    });

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ cid: `${attachmentId}@weldmail`, contentType: 'image/png', filename: 'logo.png' });
    const { raw } = buildRfc5322({
      from: { email: SELF },
      to: [{ email: 'friend@example.com' }],
      subject: 'x',
      html,
      attachments: parts,
    });
    expect(raw).toMatch(/Content-Type: multipart\/related/);
    expect(raw).toContain(`Content-ID: <${attachmentId}@weldmail>`);
    expect(raw).toMatch(/Content-Disposition: inline; filename="logo.png"/);
  });

  it('drops minted URLs when no secret is configured', async () => {
    const accountId = await seedAccount();
    const { messageId } = await seedWithInlineImage(accountId);
    const noSecret = { STORAGE: env.STORAGE } as unknown as Env;

    const { html, parts } = await embedInlineImages(noSecret, db, await readingPaneHtml(messageId), {
      workspaceId: ORG,
      caller: USER,
      accountId,
    });

    expect(html).not.toContain(INLINE_IMAGE_PATH);
    expect(html).not.toContain('<img');
    expect(parts).toHaveLength(0);
  });
});
