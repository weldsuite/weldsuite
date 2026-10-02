import { describe, it, expect } from 'vitest';
import {
  getRemovedGuests,
  guestEmailFromUserId,
  isGuestRemovedFromSession,
  mergeRejoin,
  type MeetingSessionParticipant,
} from './meeting-sessions';

describe('isGuestRemovedFromSession', () => {
  const metadata = {
    botId: 'bot_1',
    removedGuests: { 'guest@example.com': { removedAt: '2026-10-02T10:00:00.000Z', removedBy: 'user_host' } },
  };

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(isGuestRemovedFromSession(metadata, 'guest@example.com')).toBe(true);
    expect(isGuestRemovedFromSession(metadata, '  Guest@Example.COM ')).toBe(true);
  });

  it('is false for other emails, empty email, and missing metadata', () => {
    expect(isGuestRemovedFromSession(metadata, 'other@example.com')).toBe(false);
    expect(isGuestRemovedFromSession(metadata, '')).toBe(false);
    expect(isGuestRemovedFromSession(null, 'guest@example.com')).toBe(false);
    expect(isGuestRemovedFromSession(undefined, 'guest@example.com')).toBe(false);
    expect(isGuestRemovedFromSession({}, 'guest@example.com')).toBe(false);
  });

  it('does not treat inherited object keys as removed', () => {
    expect(isGuestRemovedFromSession(metadata, 'constructor')).toBe(false);
    expect(isGuestRemovedFromSession(metadata, 'toString')).toBe(false);
  });

  it('tolerates malformed removedGuests values', () => {
    expect(getRemovedGuests({ removedGuests: 'nope' })).toEqual({});
    expect(getRemovedGuests({ removedGuests: ['a@b.c'] })).toEqual({});
    expect(getRemovedGuests({ removedGuests: null })).toEqual({});
  });
});

describe('guestEmailFromUserId', () => {
  it('extracts and lowercases the email of a guest user id', () => {
    expect(guestEmailFromUserId('guest:Jane@Example.com')).toBe('jane@example.com');
  });

  it('returns null for members and empty guest ids', () => {
    expect(guestEmailFromUserId('user_2abc')).toBeNull();
    expect(guestEmailFromUserId('guest:')).toBeNull();
  });
});

const base: MeetingSessionParticipant = {
  userId: 'user_1',
  userName: 'Ada',
  joinedAt: '2026-10-02T10:00:00.000Z',
  cfSessionId: 'cf_1',
  hasAudio: false,
  hasVideo: false,
  hasScreenShare: false,
};

const rejoin = (over: Partial<MeetingSessionParticipant> = {}): MeetingSessionParticipant => ({
  ...base,
  joinedAt: '2026-10-02T10:30:00.000Z',
  cfSessionId: 'cf_2',
  ...over,
});

describe('mergeRejoin', () => {
  it('returns the new entry untouched when there is no previous one', () => {
    const next = rejoin();
    expect(mergeRejoin(undefined, next)).toBe(next);
  });

  it('starts a second stint after a leave: keeps the first join and adds the time spent', () => {
    const prev = { ...base, leftAt: '2026-10-02T10:10:00.000Z' };
    const merged = mergeRejoin(prev, rejoin());
    expect(merged).toMatchObject({
      joinedAt: '2026-10-02T10:30:00.000Z',
      cfSessionId: 'cf_2',
      firstJoinedAt: '2026-10-02T10:00:00.000Z',
      priorSeconds: 600,
      stints: 2,
    });
    expect(merged.leftAt).toBeUndefined();
  });

  it('accumulates over several rejoins', () => {
    const second = mergeRejoin({ ...base, leftAt: '2026-10-02T10:10:00.000Z' }, rejoin());
    const left = { ...second, leftAt: '2026-10-02T10:35:00.000Z' };
    const third = mergeRejoin(left, rejoin({ joinedAt: '2026-10-02T11:00:00.000Z', cfSessionId: 'cf_3' }));
    expect(third).toMatchObject({
      firstJoinedAt: '2026-10-02T10:00:00.000Z',
      joinedAt: '2026-10-02T11:00:00.000Z',
      priorSeconds: 600 + 300,
      stints: 3,
    });
  });

  it('treats a rejoin without a recorded leave as the same stint', () => {
    const merged = mergeRejoin(base, rejoin());
    expect(merged).toMatchObject({
      joinedAt: '2026-10-02T10:00:00.000Z',
      firstJoinedAt: '2026-10-02T10:00:00.000Z',
      cfSessionId: 'cf_2',
    });
    expect(merged.priorSeconds).toBeUndefined();
    expect(merged.stints).toBeUndefined();
  });

  it('never adds a negative stint', () => {
    const prev = { ...base, leftAt: '2026-10-02T09:00:00.000Z' };
    expect(mergeRejoin(prev, rejoin()).priorSeconds).toBe(0);
  });
});
