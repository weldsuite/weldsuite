import { describe, it, expect } from 'vitest';
import {
  buildParticipantLookup,
  findGuestEmail,
  findParticipantLink,
  guestEmailFromUserId,
} from './participant-links';

describe('guestEmailFromUserId', () => {
  it('extracts and lower-cases the email of a portal guest', () => {
    expect(guestEmailFromUserId('guest:Jane.Doe@Example.com')).toBe('jane.doe@example.com');
  });

  it('ignores signed-in users and malformed guest ids', () => {
    expect(guestEmailFromUserId('user_2abc')).toBeUndefined();
    expect(guestEmailFromUserId('guest:not-an-email')).toBeUndefined();
    expect(guestEmailFromUserId('guest:')).toBeUndefined();
    expect(guestEmailFromUserId(undefined)).toBeUndefined();
  });
});

describe('buildParticipantLookup', () => {
  it('indexes a link under userId, customParticipantId and cfSessionId', () => {
    const lookup = buildParticipantLookup([
      { userId: 'guest:a@x.com', customParticipantId: 'seed-1', cfSessionId: 'rtk-1', personId: 'per_1' },
    ]);
    for (const key of ['guest:a@x.com', 'seed-1', 'rtk-1']) {
      expect(lookup.links.get(key)).toMatchObject({ personId: 'per_1' });
    }
  });

  it('keeps a linkless guest in the email map (the case that used to create duplicates)', () => {
    const lookup = buildParticipantLookup([
      { userId: 'guest:late@x.com', customParticipantId: 'seed-2', cfSessionId: 'rtk-2' },
    ]);
    expect(lookup.links.size).toBe(0);
    expect(findGuestEmail(lookup, ['seed-2'])).toBe('late@x.com');
    expect(findGuestEmail(lookup, [undefined, 'rtk-2'])).toBe('late@x.com');
  });

  it('does not treat signed-in participants as guests', () => {
    const lookup = buildParticipantLookup([
      { userId: 'user_1', customParticipantId: 'user_1', cfSessionId: 'rtk-3', workspaceMemberId: 'mem_1' },
    ]);
    expect(lookup.guestEmails.size).toBe(0);
    expect(findParticipantLink(lookup, ['rtk-3'])).toMatchObject({ workspaceMemberId: 'mem_1' });
  });

  it('lets the first row claim an identifier, skipping rows with no link', () => {
    const lookup = buildParticipantLookup([
      { userId: 'user_1', cfSessionId: 'rtk-a' },
      { userId: 'user_1', cfSessionId: 'rtk-b', workspaceMemberId: 'mem_1' },
      { userId: 'user_1', cfSessionId: 'rtk-c', workspaceMemberId: 'mem_other' },
    ]);
    expect(lookup.links.get('user_1')).toMatchObject({ workspaceMemberId: 'mem_1' });
  });

  it('copes with a missing or empty session', () => {
    expect(buildParticipantLookup(null).links.size).toBe(0);
    expect(buildParticipantLookup(undefined).guestEmails.size).toBe(0);
    expect(buildParticipantLookup([]).links.size).toBe(0);
  });
});

describe('findParticipantLink', () => {
  const lookup = buildParticipantLookup([
    { userId: 'guest:a@x.com', cfSessionId: 'rtk-1', personId: 'per_1' },
    { userId: 'user_9', cfSessionId: 'rtk-9', workspaceMemberId: 'mem_9' },
  ]);

  it('tries candidates in order and skips empty ones', () => {
    expect(findParticipantLink(lookup, [undefined, 'nope', 'rtk-1'])).toMatchObject({ personId: 'per_1' });
    expect(findParticipantLink(lookup, ['rtk-9', 'rtk-1'])).toMatchObject({ workspaceMemberId: 'mem_9' });
  });

  it('returns undefined on a miss', () => {
    expect(findParticipantLink(lookup, ['unknown'])).toBeUndefined();
    expect(findParticipantLink(lookup, [])).toBeUndefined();
  });
});
