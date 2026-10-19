/**
 * pglite-backed tests for inline images in read messages (TASK-905).
 *
 * - GET /api/mail-messages/:id and /:id/thread return HTML whose `cid:`
 *   references and old public storage URLs point at /public/mail-inline.
 * - GET /public/mail-inline/:token serves those bytes with no session, and a
 *   tampered, foreign-workspace or non-image token gets a 404.
 * - Without any secret the HTML keeps its `cid:` references.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { mailInlineImagesRoutes } from './index';
import { mailMessagesRoutes } from '../mail-messages';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';
import { inlineImageExpiry, sealInlineImageToken } from '@weldsuite/mail-domain/inline-images';
import type { Env, Variables } from '../../types';

const { mailAccounts, mailAttachments, mailMessages, workspaceMembers } = schema;

const ORG = 'org_test_default';
const USER = 'user_reader';
const SECRET = 'inline-secret';
const MAIL_API = 'https://mail-api.test';
const PUBLIC_URL = 'https://weldsuite-storage.weldsuite.org';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

let db: Database;
let messageId: string;
let legacyMessageId: string;

const objects = new Map<string, Uint8Array>();
const storage = {
  get: async (key: string) => {
    const body = objects.get(key);
    return body === undefined ? null : { body: new Response(body).body, size: body.length };
  },
} as unknown as R2Bucket;

function messagesApi(env: Partial<Env>) {
  const { request } = createTestApp<Env, Variables>('/api/mail-messages', mailMessagesRoutes as never, {
    context: { userId: USER, tenantDb: db, permissions: permissions('messages:read') },
    env: { STORAGE: storage, ...env } as Partial<Env>,
  });
  return (path: string) => request(`/api/mail-messages${path}`);
}

function imagesApi(env: Partial<Env> = { MAIL_INLINE_IMAGE_SECRET: SECRET }) {
  const { request } = createTestApp<Env, Variables>('/public/mail-inline', mailInlineImagesRoutes as never, {
    env: { STORAGE: storage, ...env } as Partial<Env>,
  });
  return (path: string) => request(path);
}

const SIGNED_ENV: Partial<Env> = { MAIL_INLINE_IMAGE_SECRET: SECRET, MAIL_API_PUBLIC_URL: MAIL_API };

function inlineUrls(html: string): string[] {
  return [...html.matchAll(/https:\/\/mail-api\.test(\/public\/mail-inline\/[A-Za-z0-9_-]+)/g)].map((m) => m[1]!);
}

async function seedMessage(accountId: string, threadId: string, htmlBody: string): Promise<string> {
  const id = generateId('mmsg');
  await db.insert(mailMessages).values({
    id,
    accountId,
    threadId,
    messageId: `<${id}@test.dev>`,
    from: { email: 'sender@example.com', name: 'Sender' },
    to: [{ email: 'me@test.dev' }],
    subject: 'Inline image',
    sentDate: new Date(),
    labels: ['INBOX'],
    htmlBody,
    hasAttachments: true,
  });
  return id;
}

async function seedImage(message: string, values: Partial<typeof mailAttachments.$inferInsert>): Promise<string> {
  const storagePath = `workspaces/${ORG}/mail/attachments/${message}/1_logo.png`;
  objects.set(storagePath, PNG);
  await db.insert(mailAttachments).values({
    id: generateId('attach'),
    messageId: message,
    fileName: 'logo.png',
    contentType: 'image/png',
    size: PNG.length,
    storagePath,
    isInline: true,
    ...values,
  });
  return storagePath;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const now = new Date();
  await db.insert(workspaceMembers).values({
    id: generateId('wm'),
    userId: USER,
    email: `${USER}@test.dev`,
    role: 'MEMBER',
    createdAt: now,
    updatedAt: now,
  } as typeof workspaceMembers.$inferInsert);
  const accountId = generateId('mail');
  await db.insert(mailAccounts).values({ id: accountId, name: 'Shared', email: `${accountId}@test.dev`, isShared: true });

  const thread = `thread_${accountId}`;
  messageId = await seedMessage(accountId, thread, '<p>Hi <img src="cid:logo@acme" alt="logo"></p>');
  await seedImage(messageId, { contentId: 'logo@acme' });

  // Stored before TASK-905: the inbound worker had already put the public URL in.
  legacyMessageId = generateId('mmsg');
  const legacyKey = `workspaces/${ORG}/mail/attachments/${legacyMessageId}/1_logo.png`;
  await db.insert(mailMessages).values({
    id: legacyMessageId,
    accountId,
    threadId: thread,
    messageId: `<${legacyMessageId}@test.dev>`,
    from: { email: 'sender@example.com' },
    to: [{ email: 'me@test.dev' }],
    subject: 'Re: Inline image',
    sentDate: new Date(Date.now() + 1000),
    labels: ['INBOX'],
    htmlBody: `<img src="${PUBLIC_URL}/${legacyKey}">`,
    hasAttachments: true,
  });
  await seedImage(legacyMessageId, { downloadUrl: `${PUBLIC_URL}/${legacyKey}` });
}, 60_000);

describe('read routes mint inline-image URLs', () => {
  it('GET /:id swaps cid: for a /public/mail-inline URL that serves the image', async () => {
    const res = await messagesApi(SIGNED_ENV)(`/${messageId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { htmlBody: string } };
    expect(body.data.htmlBody).not.toContain('cid:');
    expect(JSON.stringify(body)).not.toContain(PUBLIC_URL);
    const [path] = inlineUrls(body.data.htmlBody);
    expect(path).toBeDefined();

    const image = await imagesApi()(path!);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('x-content-type-options')).toBe('nosniff');
    expect(image.headers.get('content-security-policy')).toContain('sandbox');
    expect(image.headers.get('cache-control')).toMatch(/^private, max-age=\d+$/);
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);
  });

  it('GET /:id/thread rewrites the public URL of a message stored before the change', async () => {
    const res = await messagesApi(SIGNED_ENV)(`/${messageId}/thread`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { messages: Array<{ id: string; htmlBody: string }> } };
    expect(JSON.stringify(body)).not.toContain(PUBLIC_URL);
    const legacy = body.data.messages.find((m) => m.id === legacyMessageId)!;
    const [path] = inlineUrls(legacy.htmlBody);
    expect((await imagesApi()(path!)).status).toBe(200);
  });

  it('falls back to DATABASE_ENCRYPTION_KEY for the secret', async () => {
    const env = { DATABASE_ENCRYPTION_KEY: 'db-key', MAIL_API_PUBLIC_URL: MAIL_API } as Partial<Env>;
    const res = await messagesApi(env)(`/${messageId}`);
    const [path] = inlineUrls(((await res.json()) as { data: { htmlBody: string } }).data.htmlBody);
    expect((await imagesApi(env)(path!)).status).toBe(200);
    expect((await imagesApi()(path!)).status).toBe(404);
  });

  it('keeps cid: when no secret is configured', async () => {
    const res = await messagesApi({})(`/${messageId}`);
    const body = (await res.json()) as { data: { htmlBody: string } };
    expect(body.data.htmlBody).toContain('cid:logo@acme');
  });
});

describe('GET /public/mail-inline/:token', () => {
  const key = () => `workspaces/${ORG}/mail/attachments/${messageId}/1_logo.png`;
  const seal = (over: Record<string, unknown> = {}) =>
    sealInlineImageToken(SECRET, { w: ORG, a: 'attach_x', k: key(), t: 'image/png', e: inlineImageExpiry(), ...over });

  it('serves a valid token', async () => {
    expect((await imagesApi()(`/public/mail-inline/${await seal()}`)).status).toBe(200);
  });

  it('404s a tampered, expired, non-image or foreign-workspace token', async () => {
    const token = await seal();
    const tampered = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    const expired = await seal({ e: Math.floor(Date.now() / 1000) - 1 });
    const html = await seal({ t: 'text/html' });
    const foreign = await seal({ w: 'org_other' });
    const outside = await seal({ k: 'workspaces/org_other/mail/attachments/x/1_logo.png' });
    for (const t of [tampered, expired, html, foreign, outside, 'garbage']) {
      expect((await imagesApi()(`/public/mail-inline/${t}`)).status).toBe(404);
    }
  });

  it('404s when the object is gone', async () => {
    const token = await seal({ k: `workspaces/${ORG}/mail/attachments/none/1_missing.png` });
    expect((await imagesApi()(`/public/mail-inline/${token}`)).status).toBe(404);
  });
});
