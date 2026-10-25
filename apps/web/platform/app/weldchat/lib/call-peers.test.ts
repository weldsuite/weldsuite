import { describe, expect, it } from 'vitest';
import { currentPeers, peerKey } from './call-peers';

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
