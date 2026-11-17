import { describe, expect, it } from 'vitest';
import { currentPeers, peerKey, usersInCall, waitingMembers } from './call-peers';

const self = { id: 'peer_me', userId: 'rtk_me', customParticipantId: 'user_me' };

describe('peerKey', () => {
  it('prefers the app id, then the RTK user id, then the peer id', () => {
    expect(peerKey({ id: 'p', userId: 'u', customParticipantId: 'c' })).toBe('c');
    expect(peerKey({ id: 'p', userId: 'u' })).toBe('u');
    expect(peerKey({ id: 'p', userId: '', customParticipantId: '' })).toBe('p');
    expect(peerKey(undefined)).toBeUndefined();
  });
});

describe('currentPeers', () => {
  it('keeps everyone when nobody is listed twice', () => {
    const joined = [
      { id: 'peer_a', customParticipantId: 'user_a' },
      { id: 'peer_b', customParticipantId: 'user_b' },
    ];

    expect(currentPeers(joined, self)).toEqual(joined);
  });

  it("shows a rejoined teammate once, on their new session, in their old tile's place", () => {
    const stale = { id: 'peer_a1', customParticipantId: 'user_a' };
    const other = { id: 'peer_b', customParticipantId: 'user_b' };
    const rejoined = { id: 'peer_a2', customParticipantId: 'user_a' };

    expect(currentPeers([stale, other, rejoined], self)).toEqual([rejoined, other]);
  });

  it('matches a rejoin by the app id even when RealtimeKit gave it a new user id', () => {
    const stale = { id: 'peer_a1', userId: 'rtk_a1', customParticipantId: 'user_a' };
    const rejoined = { id: 'peer_a2', userId: 'rtk_a2', customParticipantId: 'user_a' };

    expect(currentPeers([stale, rejoined], self)).toEqual([rejoined]);
  });

  it("drops the local user's own earlier session after they rejoined", () => {
    const ownStale = { id: 'peer_me_old', userId: 'rtk_me_old', customParticipantId: 'user_me' };
    const other = { id: 'peer_b', customParticipantId: 'user_b' };

    expect(currentPeers([ownStale, other], self)).toEqual([other]);
  });

  it('keeps peers without an app or user id apart', () => {
    const joined = [{ id: 'peer_x' }, { id: 'peer_y' }];

    expect(currentPeers(joined, undefined)).toEqual(joined);
  });
});

describe('usersInCall', () => {
  it('lists everyone with an entry they have not left, once', () => {
    expect(
      usersInCall([
        { userId: 'user_caller', leftAt: null },
        { userId: 'user_me' },
        { userId: 'user_gone', leftAt: '2026-11-17T15:17:47.000Z' },
        // A rejoin writes a fresh entry next to the left one.
        { userId: 'user_back', leftAt: '2026-11-17T15:17:40.000Z' },
        { userId: 'user_back', leftAt: null },
        { userId: 'user_caller', leftAt: null },
        { leftAt: null },
      ]),
    ).toEqual(['user_caller', 'user_me', 'user_back']);
  });

  it('is empty without participants (an older server, or the caller)', () => {
    expect(usersInCall(undefined)).toEqual([]);
    expect(usersInCall([])).toEqual([]);
  });
});

describe('waitingMembers', () => {
  const caller = { userId: 'user_caller', name: 'Caller' };
  const callee = { userId: 'user_callee', name: 'Callee' };
  const other = { userId: 'user_other', name: 'Other' };

  it('shows the caller everyone they rang who is not in the room yet, as ringing', () => {
    expect(
      waitingMembers({ members: [callee, other], inRoom: new Set(['user_other']), isCallInitiator: true, inCall: [] }),
    ).toEqual([{ member: callee, state: 'ringing' }]);
  });

  it('shows whoever answers the caller as connecting, never as ringing, until the caller is in the room', () => {
    const waiting = waitingMembers({
      members: [caller],
      inRoom: new Set(),
      isCallInitiator: false,
      inCall: ['user_caller', 'user_callee'],
    });

    expect(waiting).toEqual([{ member: caller, state: 'connecting' }]);
    expect(
      waitingMembers({ members: [caller], inRoom: new Set(['user_caller']), isCallInitiator: false, inCall: ['user_caller'] }),
    ).toEqual([]);
  });

  it('shows a joiner only the people already in the call, as nobody rang the others for them', () => {
    expect(
      waitingMembers({ members: [caller, other], inRoom: new Set(), isCallInitiator: false, inCall: ['user_caller'] }),
    ).toEqual([{ member: caller, state: 'connecting' }]);
    // Before the join answered, nobody is known to be in the call yet.
    expect(waitingMembers({ members: [caller], inRoom: new Set(), isCallInitiator: false, inCall: [] })).toEqual([]);
  });

  it('skips members without a user id', () => {
    const ghost: { userId?: string; name: string } = { name: 'Ghost' };
    expect(waitingMembers({ members: [ghost], inRoom: new Set(), isCallInitiator: true, inCall: [] })).toEqual([]);
  });
});
