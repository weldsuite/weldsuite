import { describe, it, expect } from 'vitest';
import { inviteEmailFromQuery, inviteGuestId } from './guest-invite';

describe('inviteEmailFromQuery', () => {
  it('accepts a valid address and trims it', () => {
    expect(inviteEmailFromQuery('  jane@acme.com ', [])).toBe('jane@acme.com');
  });

  it('rejects text that is not an email', () => {
    expect(inviteEmailFromQuery('jane', [])).toBeNull();
    expect(inviteEmailFromQuery('jane@', [])).toBeNull();
    expect(inviteEmailFromQuery('jane@acme', [])).toBeNull();
    expect(inviteEmailFromQuery('', [])).toBeNull();
    expect(inviteEmailFromQuery('jane doe@acme.com', [])).toBeNull();
  });

  it('rejects an address that is already a guest, ignoring case', () => {
    expect(inviteEmailFromQuery('Jane@Acme.com', ['jane@acme.com'])).toBeNull();
  });

  it('allows an address that differs from the existing guests', () => {
    expect(inviteEmailFromQuery('bob@acme.com', ['jane@acme.com'])).toBe('bob@acme.com');
  });
});

describe('inviteGuestId', () => {
  it('derives a stable lower-cased id from the address', () => {
    expect(inviteGuestId(' Jane@Acme.com ')).toBe('email-jane@acme.com');
  });
});
