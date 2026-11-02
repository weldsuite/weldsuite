/**
 * DB-backed tests for /api/chat-clips: marking a clip's transcript as
 * processing, and the transcript callback that fills it in.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { chatClipsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

let db: Database;
const ANN = 'user_clip_ann';
const BOB = 'user_clip_bob';
let publicId: string;
let privateId: string;
let messageId: string;

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function app(userId: string) {
  return createTestApp('/api/chat-clips', chatClipsRoutes, {
    context: { userId, permissions: permissions('messages:create', 'messages:update'), tenantDb: db },
  });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const now = new Date();
  publicId = generateId('ch');
  privateId = generateId('ch');
  await db.insert(schema.chatChannels).values([
    { id: publicId, name: 'clips', slug: `clips-${publicId}`, type: 'public', createdAt: now, updatedAt: now },
    { id: privateId, name: 'clips-private', slug: `clips-private-${privateId}`, type: 'private', createdAt: now, updatedAt: now },
  ]);
  messageId = generateId('msg');
  await db.insert(schema.chatMessages).values({
    id: messageId,
    channelId: publicId,
    authorId: ANN,
    authorName: 'Ann',
    content: '',
    hasAttachments: true,
    attachments: [
      { id: 'att_file', fileName: 'a.pdf', fileSize: 10, mimeType: 'application/pdf', url: 'https://x/a.pdf' },
      {
        id: 'att_clip', fileName: 'voice.webm', fileSize: 20, mimeType: 'audio/webm', url: 'https://x/v.webm',
        clipType: 'audio', durationSeconds: 3,
      },
    ],
    createdAt: now,
    updatedAt: now,
  } as typeof schema.chatMessages.$inferInsert);
}, 60_000);

describe('/api/chat-clips', () => {
  it('marks a clip as processing, then stores its transcript', async () => {
    const started = await app(ANN).request(`/api/chat-clips/${publicId}`, json({ messageId, attachmentId: 'att_clip' }));
    expect(started.status).toBe(200);
    expect(((await started.json()) as { data: { status: string } }).data.status).toBe('processing');

    const transcript = {
      status: 'completed',
      fullText: 'hello there',
      segments: [{ text: 'hello there', startTime: 0, endTime: 1.5, timestamp: '00:00' }],
    };
    const done = await app(ANN).request(
      `/api/chat-clips/${publicId}/${messageId}/transcript`,
      json({ attachmentId: 'att_clip', transcript }, 'PATCH'),
    );
    expect(done.status).toBe(200);
    const [row] = await db.select().from(schema.chatMessages).where(eq(schema.chatMessages.id, messageId));
    const clip = (row?.attachments as Array<{ id: string; transcript?: { fullText?: string } }>).find((a) => a.id === 'att_clip');
    expect(clip?.transcript?.fullText).toBe('hello there');
  });

  it('refuses a plain file, a missing message, a hidden channel and a bad transcript', async () => {
    expect((await app(ANN).request(`/api/chat-clips/${publicId}`, json({ messageId, attachmentId: 'att_file' }))).status).toBe(404);
    expect((await app(ANN).request(`/api/chat-clips/${publicId}`, json({ messageId: 'msg_missing', attachmentId: 'att_clip' }))).status).toBe(404);
    expect((await app(BOB).request(`/api/chat-clips/${privateId}`, json({ messageId, attachmentId: 'att_clip' }))).status).toBe(403);
    expect((await app(ANN).request(`/api/chat-clips/${publicId}`, json({ messageId }))).status).toBe(400);
    expect(
      (await app(ANN).request(
        `/api/chat-clips/${publicId}/${messageId}/transcript`,
        json({ attachmentId: 'att_clip', transcript: { status: 'done' } }, 'PATCH'),
      )).status,
    ).toBe(400);
    expect(
      (await app(BOB).request(
        `/api/chat-clips/${privateId}/${messageId}/transcript`,
        json({ attachmentId: 'att_clip', transcript: { status: 'failed', errorMessage: 'x' } }, 'PATCH'),
      )).status,
    ).toBe(403);
  });
});
