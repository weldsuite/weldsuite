import { describe, expect, it } from 'vitest';
import { applyParticipantJoined, applyParticipantLeft, findLeavingParticipant } from './rtk-webhook';

const ids = (over: Partial<Parameters<typeof findLeavingParticipant>[1]> = {}) => ({
  cfSessionId: undefined,
  customId: 'user_1',
  leftAt: undefined,
  ...over,
});

describe('findLeavingParticipant', () => {
  it('matches the still-present entry, not an earlier stint that already left', () => {
    const participants = [
      { userId: 'user_1', joinedAt: '2026-10-02T10:00:00.000Z', leftAt: '2026-10-02T10:05:00.000Z' },
      { userId: 'user_1', joinedAt: '2026-10-02T10:10:00.000Z' },
    ];
    expect(findLeavingParticipant(participants, ids({ leftAt: '2026-10-02T10:20:00.000Z' }))).toBe(1);
  });

  it('ignores a leave stamped before the participant (re)joined — a replay or late retry', () => {
    const participants = [{ userId: 'user_1', joinedAt: '2026-10-02T10:10:00.000Z' }];
    expect(findLeavingParticipant(participants, ids({ leftAt: '2026-10-02T10:05:00.000Z' }))).toBe(-1);
  });

  it('matches on cfSessionId first', () => {
    const participants = [
      { userId: 'user_2', cfSessionId: 'cf_a', joinedAt: '2026-10-02T10:00:00.000Z' },
    ];
    expect(findLeavingParticipant(participants, ids({ cfSessionId: 'cf_a', customId: undefined }))).toBe(0);
  });

  it('accepts a leave without a timestamp (legacy payloads)', () => {
    const participants = [{ userId: 'user_1', joinedAt: '2026-10-02T10:10:00.000Z' }];
    expect(findLeavingParticipant(participants, ids())).toBe(0);
  });

  it('returns -1 when nobody matches', () => {
    expect(findLeavingParticipant([{ userId: 'user_9', joinedAt: '2026-10-02T10:00:00.000Z' }], ids())).toBe(-1);
  });
});

describe('findLeavingParticipant · connection that predates the latest join', () => {
  it('ignores the leave of an old connection that RealtimeKit only noticed after the rejoin', () => {
    // Joined 10:00, connection dropped, rejoined 10:20 (same stint, joinedAt kept).
    // RealtimeKit reports the dead connection at 10:21: after the rejoin.
    const participants = [
      { userId: 'user_1', joinedAt: '2026-10-02T10:00:00.000Z', lastJoinAt: '2026-10-02T10:20:00.000Z' },
    ];
    const leave = ids({ leftAt: '2026-10-02T10:21:00.000Z', peerJoinedAt: '2026-10-02T10:00:05.000Z' });
    expect(findLeavingParticipant(participants, leave)).toBe(-1);
  });

  it('still matches the leave of the connection that belongs to the latest join', () => {
    const participants = [
      { userId: 'user_1', joinedAt: '2026-10-02T10:00:00.000Z', lastJoinAt: '2026-10-02T10:20:00.000Z' },
    ];
    const leave = ids({ leftAt: '2026-10-02T10:40:00.000Z', peerJoinedAt: '2026-10-02T10:20:04.000Z' });
    expect(findLeavingParticipant(participants, leave)).toBe(0);
  });
});

describe('applyParticipantLeft', () => {
  const NOW = '2026-10-02T11:00:00.000Z';

  it('marks the participant as left when their only connection goes', () => {
    const participants = [{ userId: 'user_1', joinedAt: '2026-10-02T10:00:00.000Z', peerIds: ['peer_a'] }];
    const result = applyParticipantLeft(participants, ids({ peerId: 'peer_a' }), NOW);
    expect(result).toMatchObject({ changed: true, markedLeft: true });
    expect(result.participants[0]).toEqual({ userId: 'user_1', joinedAt: '2026-10-02T10:00:00.000Z', leftAt: NOW });
  });

  it('keeps the participant while another connection of theirs is in the room (reconnect, second tab)', () => {
    const participants = [
      { userId: 'user_1', joinedAt: '2026-10-02T10:00:00.000Z', peerIds: ['peer_old', 'peer_new'] },
    ];
    const result = applyParticipantLeft(participants, ids({ peerId: 'peer_old' }), NOW);
    expect(result).toMatchObject({ changed: true, markedLeft: false });
    expect(result.participants[0]).toEqual({
      userId: 'user_1',
      joinedAt: '2026-10-02T10:00:00.000Z',
      peerIds: ['peer_new'],
    });
  });

  it('does not mark anyone for an unknown connection while a known one is live', () => {
    const participants = [{ userId: 'user_1', joinedAt: '2026-10-02T10:00:00.000Z', peerIds: ['peer_new'] }];
    const result = applyParticipantLeft(participants, ids({ peerId: 'peer_untracked' }), NOW);
    expect(result).toMatchObject({ changed: false, markedLeft: false });
    expect(result.participants).toEqual(participants);
  });

  it('falls back to marking the participant when no connections are tracked (join events not delivered)', () => {
    const participants = [{ userId: 'user_1', joinedAt: '2026-10-02T10:00:00.000Z' }];
    const result = applyParticipantLeft(participants, ids({ peerId: 'peer_a' }), NOW);
    expect(result.markedLeft).toBe(true);
    expect(result.participants[0]).toMatchObject({ leftAt: NOW });
  });

  it('forgets a connection on an entry that already left, without touching its leave time', () => {
    const leftAt = '2026-10-02T10:30:00.000Z';
    const participants = [{ userId: 'user_1', joinedAt: '2026-10-02T10:00:00.000Z', leftAt, peerIds: ['peer_a'] }];
    const result = applyParticipantLeft(participants, ids({ peerId: 'peer_a' }), NOW);
    expect(result).toMatchObject({ changed: true, markedLeft: false });
    expect(result.participants[0]).toEqual({ userId: 'user_1', joinedAt: '2026-10-02T10:00:00.000Z', leftAt });
  });

  it('leaves other participants alone', () => {
    const participants = [
      { userId: 'user_1', joinedAt: '2026-10-02T10:00:00.000Z', peerIds: ['peer_a'] },
      { userId: 'user_2', joinedAt: '2026-10-02T10:00:00.000Z', peerIds: ['peer_b'] },
    ];
    const result = applyParticipantLeft(participants, ids({ peerId: 'peer_a' }), NOW);
    expect(result.participants[1]).toBe(participants[1]);
  });
});

describe('applyParticipantJoined', () => {
  it('tracks the connection of a participant who is in the room', () => {
    const participants = [{ userId: 'user_1', joinedAt: '2026-10-02T10:00:00.000Z' }];
    const result = applyParticipantJoined(participants, { customId: 'user_1', peerId: 'peer_a' });
    expect(result).toMatchObject({ changed: true, restored: false });
    expect(result.participants[0]).toMatchObject({ peerIds: ['peer_a'] });
  });

  it('brings back a participant recorded as left: the SDK reconnected on a new connection', () => {
    const participants = [
      { userId: 'user_1', joinedAt: '2026-10-02T10:00:00.000Z', leftAt: '2026-10-02T10:20:00.000Z' },
    ];
    const result = applyParticipantJoined(participants, { customId: 'user_1', peerId: 'peer_new' });
    expect(result).toMatchObject({ changed: true, restored: true });
    expect(result.participants[0]).toEqual({
      userId: 'user_1',
      joinedAt: '2026-10-02T10:00:00.000Z',
      peerIds: ['peer_new'],
    });
  });

  it('is a no-op for a connection that is already tracked, and for someone we do not know', () => {
    const participants = [{ userId: 'user_1', joinedAt: '2026-10-02T10:00:00.000Z', peerIds: ['peer_a'] }];
    expect(applyParticipantJoined(participants, { customId: 'user_1', peerId: 'peer_a' }).changed).toBe(false);
    expect(applyParticipantJoined(participants, { customId: 'user_9', peerId: 'peer_z' }).changed).toBe(false);
    expect(applyParticipantJoined(participants, { customId: undefined, peerId: 'peer_z' }).changed).toBe(false);
  });

  it('a reconnect ends with the participant present, whichever event arrives first', () => {
    const start = [{ userId: 'user_1', joinedAt: '2026-10-02T10:00:00.000Z', peerIds: ['peer_old'] }];
    const leaveOld = ids({ peerId: 'peer_old' });
    const joinNew = { customId: 'user_1', peerId: 'peer_new' };
    const NOW = '2026-10-02T10:20:00.000Z';

    const leaveFirst = applyParticipantJoined(applyParticipantLeft(start, leaveOld, NOW).participants, joinNew);
    const joinFirst = applyParticipantLeft(applyParticipantJoined(start, joinNew).participants, leaveOld, NOW);

    const present = { userId: 'user_1', joinedAt: '2026-10-02T10:00:00.000Z', peerIds: ['peer_new'] };
    expect(leaveFirst.participants[0]).toEqual(present);
    expect(joinFirst.participants[0]).toEqual(present);
  });
});
