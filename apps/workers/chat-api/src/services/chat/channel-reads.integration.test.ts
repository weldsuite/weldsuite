/**
 * markChannelRead reports where the caller had read up to, so the client that
 * opens a channel can mark where the new messages start.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { markChannelRead } from './channel-reads';

let db: Database;
let channelId: string;
const READER = 'user_reader';
const NEWCOMER = 'user_newcomer';
const earlier = new Date('2026-10-01T09:00:00Z');

beforeAll(async () => {
  ({ db } = await createPgliteDb());
  const now = new Date();
  channelId = generateId('ch');
  await db.insert(schema.chatChannels).values({
    id: channelId,
    name: 'general',
    slug: 'general',
    type: 'public',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.chatChannelMembers).values([
    { id: generateId('cmb'), channelId, userId: READER, role: 'member', createdAt: now, joinedAt: now, lastReadAt: earlier },
    { id: generateId('cmb'), channelId, userId: NEWCOMER, role: 'member', createdAt: now, joinedAt: now },
  ]);
  await db.insert(schema.chatMessages).values({
    id: generateId('cmsg'),
    channelId,
    authorId: 'user_other',
    authorName: 'Other',
    content: 'new since you last looked',
    createdAt: now,
    updatedAt: now,
  });
}, 60_000);

describe('markChannelRead', () => {
  it('returns the read position from before the call, then moves it', async () => {
    const first = await markChannelRead(db, channelId, READER);
    expect(first.previousLastReadAt?.toISOString()).toBe(earlier.toISOString());
    expect(first.lastReadAt.getTime()).toBeGreaterThan(earlier.getTime());

    const second = await markChannelRead(db, channelId, READER);
    expect(second.previousLastReadAt?.toISOString()).toBe(first.lastReadAt.toISOString());
  });

  it('returns null for a member who never read the channel', async () => {
    const result = await markChannelRead(db, channelId, NEWCOMER);
    expect(result.previousLastReadAt).toBeNull();
  });
});
