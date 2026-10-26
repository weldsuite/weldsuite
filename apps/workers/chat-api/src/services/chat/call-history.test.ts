import { describe, expect, it } from 'vitest';
import type { ChatCallParticipant } from '@weldsuite/db/schema/chat-calls';
import { callCounterpart, callDirection, callOutcomeFor } from './call-history';

function p(userId: string): ChatCallParticipant {
  return {
    userId,
    userName: userId,
    joinedAt: '2026-10-01T09:00:00.000Z',
    cfSessionId: `cf_${userId}`,
    hasAudio: false,
    hasVideo: false,
    hasScreenShare: false,
  };
}

const call = (status: string, participants: ChatCallParticipant[], metadata?: Record<string, unknown>) => ({
  status,
  initiatorId: 'bob',
  participants,
  metadata: metadata ?? null,
});

describe('callDirection', () => {
  it('is outgoing for the caller and incoming for everyone else', () => {
    expect(callDirection({ initiatorId: 'bob' }, 'bob')).toBe('outgoing');
    expect(callDirection({ initiatorId: 'bob' }, 'alice')).toBe('incoming');
  });
});

describe('callOutcomeFor', () => {
  it('is ongoing while the call rings or is live, for everyone', () => {
    expect(callOutcomeFor(call('ringing', []), 'alice')).toBe('ongoing');
    expect(callOutcomeFor(call('active', [p('bob')]), 'bob')).toBe('ongoing');
  });

  it("for the caller: answered once anyone picked up, missed when nobody did, whatever the status says", () => {
    expect(callOutcomeFor(call('ended', [p('bob'), p('alice')]), 'bob')).toBe('answered');
    expect(callOutcomeFor(call('missed', [p('bob')]), 'bob')).toBe('missed');
    // A call ended twice reads `ended` although nobody picked up.
    expect(callOutcomeFor(call('ended', [p('bob')]), 'bob')).toBe('missed');
    expect(callOutcomeFor(call('declined', [p('bob')]), 'bob')).toBe('declined');
  });

  it('for someone it rang: answered only if they joined themselves', () => {
    expect(callOutcomeFor(call('ended', [p('bob'), p('alice')]), 'alice')).toBe('answered');
    expect(callOutcomeFor(call('ended', [p('bob'), p('carol')]), 'alice')).toBe('missed');
    expect(callOutcomeFor(call('missed', [p('bob')]), 'alice')).toBe('missed');
  });

  it('declined for the decliner, missed for the rest of a group DM', () => {
    const declined = call('declined', [p('bob')], { declinedBy: 'carol' });
    expect(callOutcomeFor(declined, 'carol')).toBe('declined');
    expect(callOutcomeFor(declined, 'alice')).toBe('missed');
  });

  it('declined for whoever it rang when the decliner was not recorded (older calls)', () => {
    expect(callOutcomeFor(call('declined', [p('bob')]), 'alice')).toBe('declined');
  });
});

describe('callCounterpart', () => {
  const people = new Map([['bob', { name: 'Bob B.', picture: 'bob.png' }]]);
  const members = [
    { userId: 'bob', name: 'Bob B.', avatar: 'bob.png' },
    { userId: 'carol', name: 'Carol', avatar: null },
  ];

  it('is the caller for an incoming DM call, from the workspace directory when known', () => {
    expect(callCounterpart({ initiatorId: 'bob', initiatorName: 'Bob' }, 'alice', 'dm', members, people)).toEqual({
      userId: 'bob',
      name: 'Bob B.',
      avatar: 'bob.png',
    });
    expect(callCounterpart({ initiatorId: 'dave', initiatorName: 'Dave' }, 'alice', 'dm', members, people)).toEqual({
      userId: 'dave',
      name: 'Dave',
      avatar: null,
    });
  });

  it('is the first other member for an outgoing DM call', () => {
    expect(callCounterpart({ initiatorId: 'alice', initiatorName: 'Alice' }, 'alice', 'dm', members, people)?.userId).toBe(
      'bob',
    );
    expect(callCounterpart({ initiatorId: 'alice', initiatorName: 'Alice' }, 'alice', 'dm', [], people)).toBeNull();
  });

  it('is null for a channel call', () => {
    expect(callCounterpart({ initiatorId: 'bob', initiatorName: 'Bob' }, 'alice', 'public', [], people)).toBeNull();
  });
});
