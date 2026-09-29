import { describe, expect, it } from 'vitest';
import type { ChatCallParticipant } from '@weldsuite/db/schema/chat-calls';
import { isAbandonedCall } from './call-participants';
import { RING_TIMEOUT_MS, wasAnswered } from '@weldsuite/chat-domain/call-lifecycle';

const NOW = Date.parse('2026-09-28T12:00:00Z');

function participant(userId: string, opts: { left?: boolean } = {}): ChatCallParticipant {
  return {
    userId,
    userName: userId,
    joinedAt: new Date(NOW - 5_000).toISOString(),
    ...(opts.left ? { leftAt: new Date(NOW - 1_000).toISOString() } : {}),
    cfSessionId: `sess_${userId}`,
    hasAudio: false,
    hasVideo: false,
    hasScreenShare: false,
  };
}

function call(ageMs: number, participants: ChatCallParticipant[], status = 'active') {
  return {
    status,
    createdAt: new Date(NOW - ageMs),
    initiatorId: 'alice',
    participants,
  };
}

describe('wasAnswered', () => {
  it('is false while only the initiator has joined', () => {
    expect(wasAnswered(call(1_000, [participant('alice')]))).toBe(false);
  });

  it('is true once someone else joined, even if they left again', () => {
    expect(wasAnswered(call(1_000, [participant('alice'), participant('bob', { left: true })]))).toBe(true);
  });
});

describe('isAbandonedCall in a DM', () => {
  const dm = (requesterId: string) => ({ isDm: true, requesterId, now: NOW });

  it("replaces the caller's own leftover call so the new call rings", () => {
    expect(isAbandonedCall(call(2_000, [participant('alice')]), dm('alice'))).toBe(true);
  });

  it('lets the callee answer a fresh ring by joining it', () => {
    expect(isAbandonedCall(call(2_000, [participant('alice')]), dm('bob'))).toBe(false);
  });

  it('ends an unanswered call once the ring window has passed', () => {
    expect(isAbandonedCall(call(RING_TIMEOUT_MS + 1_000, [participant('alice')]), dm('bob'))).toBe(true);
  });

  it('keeps an answered call the other person is still in', () => {
    const live = call(10 * 60_000, [participant('alice'), participant('bob')]);
    expect(isAbandonedCall(live, dm('alice'))).toBe(false);
  });

  it('ends an empty call straight away', () => {
    expect(isAbandonedCall(call(2_000, [participant('alice', { left: true })]), dm('bob'))).toBe(true);
  });
});

describe('isAbandonedCall in a channel', () => {
  const channel = (requesterId: string) => ({ isDm: false, requesterId, now: NOW });

  it('keeps a huddle someone is waiting in, however long nobody joins', () => {
    expect(isAbandonedCall(call(10 * 60_000, [participant('alice')]), channel('bob'))).toBe(false);
    expect(isAbandonedCall(call(2_000, [participant('alice')]), channel('alice'))).toBe(false);
  });

  it('still ends an empty call after a minute', () => {
    expect(isAbandonedCall(call(61_000, []), channel('bob'))).toBe(true);
    expect(isAbandonedCall(call(30_000, []), channel('bob'))).toBe(false);
  });
});
