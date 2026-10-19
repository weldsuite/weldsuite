/**
 * Inline images without a public storage URL (TASK-905).
 *
 * - The token round-trips, is deterministic within an expiry window, and is
 *   refused when tampered with, expired, or sealed with another secret.
 * - `rewriteInlineImages` swaps `cid:` references and the public storage URLs
 *   of older messages for minted URLs, and leaves everything that is not one
 *   of the message's own image attachments alone.
 * - getMessage / getThread (pglite) return rewritten HTML only when asked.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import {
  INLINE_IMAGE_PATH,
  INLINE_IMAGE_TTL_SECONDS,
  inlineImageExpiry,
  isInlineImageType,
  openInlineImageToken,
  rewriteInlineImages,
  sealInlineImageToken,
  type InlineAttachmentRef,
  type InlineImageClaims,
  type InlineImageSigner,
} from './inline-images';
import { getMessage, getThread } from './messages';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';

const { mailAccounts, mailAttachments, mailMessages } = schema;

const WS = 'org_ws';
const SECRET = 'test-secret';
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const PUBLIC_HOST = 'https://weldsuite-storage.weldsuite.org';
const signer: InlineImageSigner = {
  workspaceId: WS,
  baseUrl: 'https://mail-api.test/',
  secret: SECRET,
  now: NOW,
};

const claims = (over: Partial<InlineImageClaims> = {}): InlineImageClaims => ({
  w: WS,
  a: 'attach_1',
  k: `workspaces/${WS}/mail/attachments/m1/1_logo.png`,
  t: 'image/png',
  e: Math.floor(NOW / 1000) + 3600,
  ...over,
});

function urlToken(url: string): string {
  const prefix = `https://mail-api.test${INLINE_IMAGE_PATH}/`;
  expect(url.startsWith(prefix)).toBe(true);
  return url.slice(prefix.length);
}

function minted(html: string): string[] {
  return [...html.matchAll(/https:\/\/mail-api\.test\/public\/mail-inline\/[A-Za-z0-9_-]+/g)].map((m) => m[0]);
}

describe('inline-image token', () => {
  it('opens what it sealed, and seals the same claims to the same token', async () => {
    const token = await sealInlineImageToken(SECRET, claims());
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await sealInlineImageToken(SECRET, claims())).toBe(token);
    expect(await openInlineImageToken(SECRET, token, NOW)).toEqual(claims());
  });

  it('does not show the storage key in the token', async () => {
    const token = await sealInlineImageToken(SECRET, claims());
    expect(Buffer.from(token, 'base64url').toString('latin1')).not.toContain('workspaces/');
  });

  it('refuses an expired, tampered, foreign or malformed token', async () => {
    const token = await sealInlineImageToken(SECRET, claims());
    expect(await openInlineImageToken(SECRET, token, NOW + 3601_000)).toBeNull();
    const flipped = token.slice(0, 20) + (token[20] === 'A' ? 'B' : 'A') + token.slice(21);
    expect(await openInlineImageToken(SECRET, flipped, NOW)).toBeNull();
    expect(await openInlineImageToken('another-secret', token, NOW)).toBeNull();
    expect(await openInlineImageToken(SECRET, 'not a token', NOW)).toBeNull();
    expect(await openInlineImageToken(SECRET, 'AAAA', NOW)).toBeNull();
  });

  it('expires after at least the TTL, on a window boundary', () => {
    const e = inlineImageExpiry(NOW);
    expect(e * 1000 - NOW).toBeGreaterThanOrEqual(INLINE_IMAGE_TTL_SECONDS * 1000);
    expect(e * 1000 - NOW).toBeLessThan((INLINE_IMAGE_TTL_SECONDS + 15 * 60) * 1000);
    // Reads a few minutes apart, inside one window, mint the same expiry.
    expect(inlineImageExpiry(NOW + 60_000)).toBe(inlineImageExpiry(NOW + 5 * 60_000));
  });

  it('only treats image types as inline images', () => {
    expect(isInlineImageType('image/png')).toBe(true);
    expect(isInlineImageType('IMAGE/JPEG; name=x.jpg')).toBe(true);
    expect(isInlineImageType('text/html')).toBe(false);
    expect(isInlineImageType('application/pdf')).toBe(false);
    expect(isInlineImageType(null)).toBe(false);
  });
});

describe('rewriteInlineImages', () => {
  const logo: InlineAttachmentRef = {
    id: 'attach_logo',
    messageId: 'm1',
    contentId: '<logo@acme>',
    storagePath: `workspaces/${WS}/mail/attachments/m1/1_logo.png`,
    contentType: 'image/png',
  };

  it('swaps cid: references for minted URLs that open to the attachment', async () => {
    const html = `<p><img src="cid:logo@acme"><span style="background:url(cid:logo@acme)"></span></p>`;
    const out = await rewriteInlineImages(html, [logo], signer);
    expect(out).not.toContain('cid:');
    const urls = minted(out);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe(urls[1]);
    const opened = await openInlineImageToken(SECRET, urlToken(urls[0]!), NOW);
    expect(opened).toMatchObject({ w: WS, a: 'attach_logo', k: logo.storagePath, t: 'image/png' });
  });

  it('swaps the public storage URL an older message was stored with', async () => {
    const html = `<img src="${PUBLIC_HOST}/${logo.storagePath}"> <img src="https://pub-123.r2.dev/${logo.storagePath}">`;
    const out = await rewriteInlineImages(html, [{ ...logo, contentId: null }], signer);
    expect(out).not.toContain(PUBLIC_HOST);
    expect(out).not.toContain('r2.dev');
    expect(minted(out)).toHaveLength(2);
  });

  it('leaves references that are not one of the message own image attachments', async () => {
    const otherKey = `workspaces/${WS}/mail/attachments/m9/1_other.png`;
    const html = [
      `<img src="cid:unknown@x">`,
      `<img src="${PUBLIC_HOST}/${otherKey}">`,
      `<img src="cid:report@acme">`,
      `<img src="cid:foreign@acme">`,
    ].join('');
    const out = await rewriteInlineImages(
      html,
      [
        { ...logo, id: 'attach_pdf', contentId: 'report@acme', contentType: 'application/pdf' },
        {
          ...logo,
          id: 'attach_foreign',
          contentId: 'foreign@acme',
          storagePath: 'workspaces/org_other/mail/attachments/m1/1_x.png',
        },
      ],
      signer,
    );
    expect(out).toBe(html);
  });

  it('matches a percent-encoded cid', async () => {
    const out = await rewriteInlineImages(
      `<img src="cid:image001.png%4001D9">`,
      [{ ...logo, contentId: 'image001.png@01D9' }],
      signer,
    );
    expect(minted(out)).toHaveLength(1);
  });
});

describe('getMessage / getThread inline images (pglite)', () => {
  let db: Database;
  let accountId: string;

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
    accountId = generateId('mail');
    await db.insert(mailAccounts).values({ id: accountId, name: 'Test', email: `${accountId}@test.dev`, isShared: true });
  }, 60_000);

  async function seed(threadId: string, html: string, attachment?: Partial<typeof mailAttachments.$inferInsert>) {
    const id = generateId('mmsg');
    await db.insert(mailMessages).values({
      id,
      accountId,
      threadId,
      messageId: `<${id}@test.dev>`,
      from: { email: 'sender@example.com', name: 'Sender' },
      to: [{ email: 'me@test.dev' }],
      subject: 'Inline',
      sentDate: new Date(),
      labels: ['INBOX'],
      htmlBody: html,
      hasAttachments: !!attachment,
    });
    if (attachment) {
      await db.insert(mailAttachments).values({
        id: generateId('attach'),
        messageId: id,
        fileName: 'logo.png',
        contentType: 'image/png',
        size: 10,
        storagePath: `workspaces/${WS}/mail/attachments/${id}/1_logo.png`,
        isInline: true,
        ...attachment,
      });
    }
    return id;
  }

  it('returns the stored HTML unless a signer is passed', async () => {
    const id = await seed(`t_${generateId('t')}`, '<img src="cid:a@x">', { contentId: 'a@x' });
    expect((await getMessage(db, id))!.htmlBody).toBe('<img src="cid:a@x">');
    const signed = (await getMessage(db, id, { inlineImages: signer }))!.htmlBody!;
    expect(signed).not.toContain('cid:');
    expect(minted(signed)).toHaveLength(1);
  });

  it('rewrites every message of a thread, legacy public URLs included', async () => {
    const thread = `t_${generateId('t')}`;
    const first = await seed(thread, '<img src="cid:new@x">', { contentId: 'new@x' });
    const legacyId = generateId('mmsg');
    const legacyKey = `workspaces/${WS}/mail/attachments/${legacyId}/1_logo.png`;
    await db.insert(mailMessages).values({
      id: legacyId,
      accountId,
      threadId: thread,
      messageId: `<${legacyId}@test.dev>`,
      from: { email: 'sender@example.com' },
      to: [{ email: 'me@test.dev' }],
      subject: 'Re: Inline',
      sentDate: new Date(Date.now() + 1000),
      labels: ['INBOX'],
      htmlBody: `<img src="${PUBLIC_HOST}/${legacyKey}">`,
      hasAttachments: true,
    });
    await db.insert(mailAttachments).values({
      id: generateId('attach'),
      messageId: legacyId,
      fileName: 'logo.png',
      contentType: 'image/png',
      size: 10,
      storagePath: legacyKey,
      downloadUrl: `${PUBLIC_HOST}/${legacyKey}`,
    });
    const plain = await seed(thread, '<p>no images</p>');

    const result = await getThread(db, first, { inlineImages: signer });
    const bodies = result!.messages.map((m) => m.htmlBody ?? '');
    expect(bodies.join('')).not.toContain(PUBLIC_HOST);
    expect(bodies.join('')).not.toContain('cid:');
    expect(minted(bodies.join(''))).toHaveLength(2);
    expect(result!.messages.find((m) => m.id === plain)!.htmlBody).toBe('<p>no images</p>');
  });

  it('skips a deleted attachment', async () => {
    const id = await seed(`t_${generateId('t')}`, '<img src="cid:gone@x">', {
      contentId: 'gone@x',
      deletedAt: new Date(),
    });
    expect((await getMessage(db, id, { inlineImages: signer }))!.htmlBody).toBe('<img src="cid:gone@x">');
    expect((await getThread(db, id, { inlineImages: signer }))!.messages[0]!.htmlBody).toBe(
      '<img src="cid:gone@x">',
    );
  });
});
