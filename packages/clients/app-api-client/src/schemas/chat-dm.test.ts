import { describe, expect, it } from 'vitest';
import { isInvitePlaceholderUserId, isPendingInvitee } from './chat-dm';

describe('isInvitePlaceholderUserId', () => {
  it('matches the invitation placeholders', () => {
    expect(isInvitePlaceholderUserId('invited_ann@example.com')).toBe(true);
    expect(isInvitePlaceholderUserId('pending_clerk_inv_123')).toBe(true);
  });

  it('leaves real and missing ids alone', () => {
    expect(isInvitePlaceholderUserId('user_2abc')).toBe(false);
    expect(isInvitePlaceholderUserId('')).toBe(false);
    expect(isInvitePlaceholderUserId(null)).toBe(false);
    expect(isInvitePlaceholderUserId(undefined)).toBe(false);
  });
});

describe('isPendingInvitee', () => {
  it('is true for a PENDING member, whatever the case', () => {
    expect(isPendingInvitee({ status: 'PENDING', userId: 'user_1' })).toBe(true);
    expect(isPendingInvitee({ status: 'pending', userId: 'user_1' })).toBe(true);
  });

  it('is true while the row is still on a placeholder id, even when ACTIVE', () => {
    expect(isPendingInvitee({ status: 'ACTIVE', userId: 'pending_clerk_inv_123' })).toBe(true);
  });

  it('is false for a member who has joined', () => {
    expect(isPendingInvitee({ status: 'ACTIVE', userId: 'user_1' })).toBe(false);
    expect(isPendingInvitee({})).toBe(false);
  });
});
