import { describe, expect, it } from 'vitest';
import { availableInviteTabs, isValidEmail } from './invite-validation';

describe('isValidEmail', () => {
  it.each(['jane@example.com', 'jane.doe+tag@sub.example.co.uk', '  jane@example.com  '])('accepts %s', (value) => {
    expect(isValidEmail(value)).toBe(true);
  });

  it.each(['', 'notanemail', 'jane@', '@example.com', 'jane@example', 'jane@@example.com', 'jane doe@example.com', 'jane@example..com'])(
    'rejects %j',
    (value) => {
      expect(isValidEmail(value)).toBe(false);
    },
  );
});

describe('availableInviteTabs', () => {
  it('shows both tabs for a private channel when guests may be invited', () => {
    expect(availableInviteTabs({ isPrivate: true, canInviteExternal: true })).toEqual(['members', 'guest']);
  });

  it('shows only Guest for a public channel', () => {
    expect(availableInviteTabs({ isPrivate: false, canInviteExternal: true })).toEqual(['guest']);
  });

  it('shows only Members when guests may not be invited', () => {
    expect(availableInviteTabs({ isPrivate: true, canInviteExternal: false })).toEqual(['members']);
  });

  it('shows nothing when neither applies', () => {
    expect(availableInviteTabs({ isPrivate: false, canInviteExternal: false })).toEqual([]);
  });
});
