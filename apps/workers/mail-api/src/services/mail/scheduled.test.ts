/**
 * pglite-backed test: a scheduled message that quotes reading-pane HTML
 * stores its inline images as attachments of its own (TASK-905 follow-up).
 *
 * The minted `/public/mail-inline/:token` URLs expire within the hour, and the
 * workflow sends the stored copy later. So scheduling swaps them for `cid:`
 * references and stores the images as inline attachments, which the workflow
 * sends by Content-ID.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';

import { scheduleEmail } from './scheduled';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';
import { INLINE_IMAGE_PATH, rewriteInlineImages } from '@weldsuite/mail-domain/inline-images';
import type { Env } from '../../types';

const { mailAccounts, mailAttachments, mailMessages } = schema;

const ORG = 'org_sched';
const USER = 'user_sched';
const SECRET = 'inline-secret';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9]);

const objects = new Map<string, Uint8Array>();
const env = {
  MAIL_INLINE_IMAGE_SECRET: SECRET,
  STORAGE: {
    get: async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { arrayBuffer: async () => bytes.slice().buffer, httpMetadata: { contentType: 'image/png' } } : null;
    },
    put: async (key: string, value: ArrayBuffer) => {
      objects.set(key, new Uint8Array(value));
    },
  },
  SEND_SCHEDULED_EMAIL: { create: async ({ id }: { id: string }) => ({ id }) },
} as unknown as Env;

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('scheduleEmail · quoted inline images (pglite)', () => {
  it('stores minted image URLs as inline attachments of the scheduled message', async () => {
    const accountId = generateId('mail');
    await db.insert(mailAccounts).values({ id: accountId, name: 'Team', email: 'team@test.dev', isShared: true });
    const originalId = generateId('mmsg');
    await db.insert(mailMessages).values({
      id: originalId,
      accountId,
      messageId: `<${originalId}@example.com>`,
      threadId: `<${originalId}@example.com>`,
      from: { email: 'sender@example.com' },
      to: [{ email: 'team@test.dev' }],
      subject: 'Logo',
      sentDate: new Date(),
      htmlBody: '<img src="cid:logo@x">',
      hasAttachments: true,
    });
    const attachmentId = generateId('attach');
    const storagePath = `workspaces/${ORG}/mail/attachments/${originalId}/1_logo.png`;
    objects.set(storagePath, PNG);
    await db.insert(mailAttachments).values({
      id: attachmentId,
      messageId: originalId,
      fileName: 'logo.png',
      contentType: 'image/png',
      size: PNG.byteLength,
      storagePath,
      isInline: true,
      contentId: 'logo@x',
    });
    const readingHtml = await rewriteInlineImages(
      '<img src="cid:logo@x">',
      [{ id: attachmentId, messageId: originalId, contentId: 'logo@x', storagePath, contentType: 'image/png' }],
      { workspaceId: ORG, baseUrl: 'https://mail-api.test', secret: SECRET },
    );

    const result = await scheduleEmail(env, db, ORG, USER, {
      accountId,
      to: ['friend@example.com'],
      subject: 'Later',
      htmlBody: `<p>Later</p><blockquote>${readingHtml}</blockquote>`,
      scheduledFor: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    const [scheduled] = await db.select().from(mailMessages).where(eq(mailMessages.id, result.messageId));
    const rows = await db.select().from(mailAttachments).where(eq(mailAttachments.messageId, result.messageId));
    const cid = `${attachmentId}@weldmail`;
    expect(scheduled!.htmlBody).not.toContain(INLINE_IMAGE_PATH);
    expect(scheduled!.htmlBody).toContain(`cid:${cid}`);
    expect(scheduled!.hasAttachments).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ isInline: true, contentId: cid, contentType: 'image/png' });
    expect(objects.get(rows[0]!.storagePath!)).toEqual(PNG);
  });
});
