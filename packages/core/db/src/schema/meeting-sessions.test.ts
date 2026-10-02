import { describe, it, expect } from 'vitest';
import {
  getRemovedGuests,
  guestEmailFromUserId,
  isGuestRemovedFromSession,
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
