import { describe, expect, it } from 'vitest';
import { findLeavingParticipant } from './rtk-webhook';

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
