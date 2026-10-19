/**
 * Personal mail attachments and inline images without a public storage URL
 * (TASK-905), against the real personal schema (pglite) and a fake bucket.
 *
 * - Attachment rows come back without `storagePath` / `downloadUrl`.
 * - The download route serves the owner only, and only keys under the
 *   owner's `personal/<personalAccountId>/` folder; everything else is a 404.
 * - Read HTML points inline images (`cid:` and older public URLs) at
 *   short-lived `/public/mail-inline/:token` URLs, which serve the image.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sealInlineImageToken, inlineImageExpiry } from '@weldsuite/mail-domain/inline-images';
import { personalSchema, type PersonalDatabase } from '../db';
import { createPersonalPgliteDb } from '../test/personal-pglite';
import type { Env, Variables } from '../types';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getPersonalDb: () => holder.db,
}));

const { mailMessagesRoutes } = await import('./mail-messages');
const { mailInlineImagesRoutes } = await import('./mail-inline-images');

const { personalMailAccounts, personalMailAttachments, personalMailMessages } = personalSchema;

const A = 'pacc_a';
const B = 'pacc_b';
const SECRET = 'inline-secret';
const ORIGIN = 'https://personal-api.test';
const PUBLIC_HOST = 'https://weldsuite-storage.weldsuite.org';
const key = (account: string, message: string, file: string) =>
  `personal/${account}/mail/attachments/${message}/${file}`;

const LOGO_KEY = key(A, 'pmsg_a', '1_logo.png');
const OLD_KEY = key(A, 'pmsg_a', '2_old.png');
const PDF_KEY = key(A, 'pmsg_a', '3_report.pdf');
const B_KEY = key(B, 'pmsg_b', '1_b.png');

/** A bucket that records which keys were read. */
function fakeBucket() {
  const objects = new Map<string, { body: string; type: string }>([
    [LOGO_KEY, { body: 'logo-bytes', type: 'image/png' }],
    [OLD_KEY, { body: 'old-bytes', type: 'image/png' }],
    [PDF_KEY, { body: '%PDF-1.7', type: 'application/pdf' }],
    [B_KEY, { body: 'b-bytes', type: 'image/png' }],
  ]);
  const reads: string[] = [];
  const bucket = {
    async get(k: string) {
      reads.push(k);
      const o = objects.get(k);
      if (!o) return null;
      return { body: new Response(o.body).body, size: o.body.length, httpMetadata: { contentType: o.type } };
    },
  };
  return { bucket: bucket as unknown as R2Bucket, reads };
}

function buildApp() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.route('/public/mail-inline', mailInlineImagesRoutes);
  app.use('/api/*', async (c, next) => {
    c.set('personalAccountId', c.req.header('x-test-account') ?? null);
    await next();
  });
  app.route('/api/mail/messages', mailMessagesRoutes);
  return app;
}

let db: PersonalDatabase;
let close: () => Promise<void>;
let storage: ReturnType<typeof fakeBucket>;
const app = buildApp();

function env(over: Partial<Env> = {}): Env {
  return {
    STORAGE: storage.bucket,
    MAIL_INLINE_IMAGE_SECRET: SECRET,
    PERSONAL_API_PUBLIC_URL: ORIGIN,
    ...over,
  } as Env;
}

function get(path: string, account: string | null, over: Partial<Env> = {}) {
  return app.request(path, { headers: account ? { 'x-test-account': account } : {} }, env(over));
}

const HTML_A = `<p><img src="cid:logo@x"><img src="${PUBLIC_HOST}/${OLD_KEY}"><img src="cid:report@x"></p>`;

beforeAll(async () => {
  ({ db, close } = await createPersonalPgliteDb());
  holder.db = db;

  await db.insert(personalMailAccounts).values(
    [A, B].map((personalAccountId) => ({
      id: `acct_${personalAccountId}`,
      personalAccountId,
      name: personalAccountId,
      email: `${personalAccountId}@weldmail.com`,
    })),
  );

  const message = (id: string, personalAccountId: string, over: Record<string, unknown> = {}) => ({
    id,
    personalAccountId,
    accountId: `acct_${personalAccountId}`,
    messageId: `<${id}@x>`,
    threadId: `thread_${id}`,
    from: { email: 'sender@example.com' },
    to: [{ email: `${personalAccountId}@weldmail.com` }],
    subject: 'Hi',
    sentDate: new Date('2026-10-19T10:00:00Z'),
    hasAttachments: true,
    ...over,
  });
  await db.insert(personalMailMessages).values([
    message('pmsg_a', A, { htmlBody: HTML_A }),
    message('pmsg_b', B, { htmlBody: '<img src="cid:b@x">' }),
    message('pmsg_gone', A, { deletedAt: new Date() }),
  ]);

  const attachment = (id: string, personalAccountId: string, messageId: string, over: Record<string, unknown>) => ({
    id,
    personalAccountId,
    messageId,
    fileName: `${id}.png`,
    contentType: 'image/png',
    size: 10,
    ...over,
  });
  await db.insert(personalMailAttachments).values([
    attachment('att_logo', A, 'pmsg_a', { contentId: 'logo@x', storagePath: LOGO_KEY, isInline: true }),
    // Stored before TASK-905: public URL, no Content-ID.
    attachment('att_old', A, 'pmsg_a', { storagePath: OLD_KEY, downloadUrl: `${PUBLIC_HOST}/${OLD_KEY}` }),
    attachment('att_pdf', A, 'pmsg_a', {
      fileName: 'report "Q3".pdf',
      contentType: 'application/pdf',
      contentId: 'report@x',
      storagePath: PDF_KEY,
      downloadUrl: `${PUBLIC_HOST}/${PDF_KEY}`,
    }),
    // A row on A's message whose key points into B's folder.
    attachment('att_rogue', A, 'pmsg_a', { storagePath: B_KEY }),
    attachment('att_deleted', A, 'pmsg_a', { storagePath: LOGO_KEY, deletedAt: new Date() }),
    attachment('att_on_gone', A, 'pmsg_gone', { storagePath: LOGO_KEY }),
    attachment('att_b', B, 'pmsg_b', { contentId: 'b@x', storagePath: B_KEY }),
  ]);
}, 60_000);

afterAll(async () => {
  await close?.();
});

beforeEach(() => {
  storage = fakeBucket();
});

describe('GET /api/mail/messages/:id/attachments', () => {
  it('lists the rows without a storage key or public URL', async () => {
    const res = await get('/api/mail/messages/pmsg_a/attachments', A);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(data.map((a) => a.id).sort()).toEqual(['att_logo', 'att_old', 'att_pdf', 'att_rogue']);
    for (const row of data) {
      expect(row).not.toHaveProperty('storagePath');
      expect(row).not.toHaveProperty('downloadUrl');
    }
    expect(JSON.stringify(data)).not.toContain(PUBLIC_HOST);
  });

  it("is a 404 for another account's message", async () => {
    expect((await get('/api/mail/messages/pmsg_a/attachments', B)).status).toBe(404);
  });
});

describe('GET /api/mail/messages/:id/attachments/:attachmentId/download', () => {
  const download = (message: string, attachment: string, account: string | null = A, over?: Partial<Env>) =>
    get(`/api/mail/messages/${message}/attachments/${attachment}/download`, account, over);

  it('serves the owner the bytes, as a download', async () => {
    const res = await download('pmsg_a', 'att_pdf');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('%PDF-1.7');
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent('report "Q3".pdf')}`,
    );
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('is the same 404 for anything the caller cannot read', async () => {
    const cases: Array<[string, string, string]> = [
      ['pmsg_a', 'att_pdf', B], // someone else's attachment
      ['pmsg_b', 'att_b', A], // someone else's message
      ['pmsg_a', 'att_b', B], // B's attachment under A's message id
      ['pmsg_a', 'att_deleted', A],
      ['pmsg_gone', 'att_on_gone', A], // deleted message
      ['pmsg_a', 'att_missing', A],
    ];
    for (const [message, attachment, account] of cases) {
      const res = await download(message, attachment, account);
      expect(res.status, `${account} → ${message}/${attachment}`).toBe(404);
    }
    expect(storage.reads).toEqual([]);
  });

  it('never reads a key outside the owner folder, whatever the row says', async () => {
    const res = await download('pmsg_a', 'att_rogue');
    expect(res.status).toBe(404);
    expect(storage.reads).not.toContain(B_KEY);
  });

  it('needs a personal account', async () => {
    expect((await download('pmsg_a', 'att_pdf', null)).status).toBe(404);
  });
});

/** The minted inline-image URLs in an HTML body. */
function mintedUrls(html: string): string[] {
  return [...html.matchAll(/https:\/\/personal-api\.test\/public\/mail-inline\/[A-Za-z0-9_-]+/g)].map((m) => m[0]);
}

describe('inline images on read', () => {
  async function readHtml(account = A, over?: Partial<Env>): Promise<string> {
    const res = await get('/api/mail/messages/pmsg_a', account, over);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { htmlBody: string } }).data.htmlBody;
  }

  it('swaps cid: references and legacy public URLs for minted URLs, images only', async () => {
    const html = await readHtml();
    expect(html).not.toContain('cid:logo@x');
    expect(html).not.toContain(PUBLIC_HOST);
    expect(mintedUrls(html)).toHaveLength(2);
    // The PDF is not an image: its cid: reference stays as it was.
    expect(html).toContain('cid:report@x');
  });

  it('rewrites the bodies of a thread listing too', async () => {
    const res = await get('/api/mail/messages?threadId=thread_pmsg_a', A);
    const { data } = (await res.json()) as { data: Array<{ htmlBody: string }> };
    expect(data).toHaveLength(1);
    expect(data[0]!.htmlBody).not.toContain(PUBLIC_HOST);
    expect(mintedUrls(data[0]!.htmlBody)).toHaveLength(2);
  });

  it('serves the image behind a minted URL', async () => {
    const [logoUrl] = mintedUrls(await readHtml());
    const res = await app.request(logoUrl!.slice(ORIGIN.length), {}, env());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('logo-bytes');
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toMatch(/^private, max-age=\d+$/);
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('keeps cid: and mints nothing without a secret', async () => {
    const html = await readHtml(A, { MAIL_INLINE_IMAGE_SECRET: undefined });
    expect(html).toBe(HTML_A);
    expect(mintedUrls(html)).toEqual([]);
  });

  it('refuses workspace, foreign-folder, non-image, tampered and expired tokens', async () => {
    const claims = { a: 'att_x', t: 'image/png', e: inlineImageExpiry() };
    const tokens = [
      await sealInlineImageToken(SECRET, { ...claims, w: 'org_ws', k: `workspaces/org_ws/mail/attachments/m/1.png` }),
      await sealInlineImageToken(SECRET, { ...claims, p: A, k: B_KEY }),
      await sealInlineImageToken(SECRET, { ...claims, p: A, k: PDF_KEY, t: 'application/pdf' }),
      await sealInlineImageToken(SECRET, { ...claims, p: A, k: LOGO_KEY, e: Math.floor(Date.now() / 1000) - 1 }),
      await sealInlineImageToken('another-secret', { ...claims, p: A, k: LOGO_KEY }),
      'not-a-token',
    ];
    for (const token of tokens) {
      const res = await app.request(`/public/mail-inline/${token}`, {}, env());
      expect(res.status).toBe(404);
    }
    expect(storage.reads).toEqual([]);
  });
});
