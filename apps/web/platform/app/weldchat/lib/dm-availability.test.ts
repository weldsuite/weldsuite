import { describe, expect, it } from 'vitest';
import { ApiError } from '@weldsuite/api-client';
import { isInvitationPendingError, isPendingInvitee } from './dm-availability';

describe('isPendingInvitee', () => {
  it('is true for a PENDING member, whatever the case', () => {
    expect(isPendingInvitee({ status: 'PENDING', userId: 'user_1' })).toBe(true);
    expect(isPendingInvitee({ status: 'pending', userId: 'user_1' })).toBe(true);
  });

  it('is true for an invitation placeholder id, even once the row says ACTIVE', () => {
    expect(isPendingInvitee({ status: 'ACTIVE', userId: 'invited_ann@example.com' })).toBe(true);
    expect(isPendingInvitee({ status: 'ACTIVE', userId: 'pending_clerk_inv_123' })).toBe(true);
  });

  it('is false for a member who has joined', () => {
    expect(isPendingInvitee({ status: 'ACTIVE', userId: 'user_1' })).toBe(false);
    expect(isPendingInvitee({ userId: 'user_1' })).toBe(false);
    expect(isPendingInvitee({ status: null, userId: null })).toBe(false);
  });
});

describe('isInvitationPendingError', () => {
  const body = (reason: string) => ({ error: { code: 'CONFLICT', message: 'x', details: { reason } } });

  it("recognises chat-api's 409 for an invitee", () => {
    expect(isInvitationPendingError(new ApiError('x', 409, body('invitation_pending')))).toBe(true);
  });

  it('ignores other conflicts and other errors', () => {
    expect(isInvitationPendingError(new ApiError('x', 409, body('something_else')))).toBe(false);
    expect(isInvitationPendingError(new ApiError('x', 404, body('invitation_pending')))).toBe(false);
    expect(isInvitationPendingError(new Error('x'))).toBe(false);
    expect(isInvitationPendingError(null)).toBe(false);
  });
});
