/**
 * Which joins may cancel a native ring. A cancel to an iPhone that is not
 * ringing flashes a CallKit call, so only a join that answers a ring sends one.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { ChatCallParticipant } from '@weldsuite/db/schema/chat-calls';
import { joinAnswersRing, type RingedCall } from './call-ring';

const ALICE = 'user_ring_alice';
const BOB = 'user_ring_bob';
const CAROL = 'user_ring_carol';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

async function channel(type: 'dm' | 'public', members: string[]): Promise<string> {
  const id = generateId('ch');
  await db.insert(schema.chatChannels).values({ id, name: id, slug: id, type } as typeof schema.chatChannels.$inferInsert);
  await db.insert(schema.chatChannelMembers).values(
    members.map((userId) => ({ id: generateId('chm'), channelId: id, userId })) as (typeof schema.chatChannelMembers.$inferInsert)[],
  );
  return id;
}

const joined = (userId: string): ChatCallParticipant => ({
  userId,
  userName: userId,
  joinedAt: new Date().toISOString(),
  cfSessionId: `cf_${userId}`,
  hasAudio: false,
  hasVideo: false,
  hasScreenShare: false,
});

const call = (channelId: string, participants: ChatCallParticipant[], createdAt = new Date()): RingedCall => ({
  id: generateId('call'),
  channelId,
  initiatorId: ALICE,
  createdAt,
  participants,
});

describe('joinAnswersRing', () => {
  it('is true for a rung DM member joining for the first time', async () => {
    const dm = await channel('dm', [ALICE, BOB]);
    expect(await joinAnswersRing(db, call(dm, [joined(ALICE)]), BOB)).toBe(true);
  });

  it('is true for a second group-DM member answering after the first', async () => {
    const dm = await channel('dm', [ALICE, BOB, CAROL]);
    expect(await joinAnswersRing(db, call(dm, [joined(ALICE), joined(BOB)]), CAROL)).toBe(true);
  });

  it('is false for a rejoin, the caller, and a channel call', async () => {
    const dm = await channel('dm', [ALICE, BOB]);
    expect(await joinAnswersRing(db, call(dm, [joined(ALICE), joined(BOB)]), BOB)).toBe(false);
    expect(await joinAnswersRing(db, call(dm, [joined(ALICE)]), ALICE)).toBe(false);

    const general = await channel('public', [ALICE, BOB]);
    expect(await joinAnswersRing(db, call(general, [joined(ALICE)]), BOB)).toBe(false);
  });

  it('is false once the phones stopped ringing by themselves', async () => {
    const dm = await channel('dm', [ALICE, BOB]);
    const old = new Date(Date.now() - 5 * 60_000);
    expect(await joinAnswersRing(db, call(dm, [joined(ALICE)], old), BOB)).toBe(false);
  });
});
