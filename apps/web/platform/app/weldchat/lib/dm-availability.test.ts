import { describe, expect, it } from 'vitest';
import { ApiError } from '@weldsuite/api-client';
import {
  canMessageMember,
  inviteesLast,
  isInvitationPendingError,
  isPendingInvitee,
  withoutInvitees,
} from './dm-availability';

const ann = { userId: 'user_ann', status: 'ACTIVE' };
const bob = { userId: 'invited_bob@example.com', status: 'PENDING' };
const cat = { userId: 'user_cat', status: 'ACTIVE' };
const dan = { userId: 'pending_clerk_inv_dan', status: 'ACTIVE' };

describe('isPendingInvitee', () => {
  it('is true for a PENDING member or a placeholder id', () => {
    expect(isPendingInvitee(bob)).toBe(true);
    expect(isPendingInvitee(dan)).toBe(true);
  });

  it('is false for a member who has joined', () => {
    expect(isPendingInvitee(ann)).toBe(false);
  });
});

describe('canMessageMember', () => {
  it('allows a member who has joined', () => {
    expect(canMessageMember(ann)).toBe(true);
  });

  it('refuses an invitee or no member at all', () => {
    expect(canMessageMember(bob)).toBe(false);
    expect(canMessageMember(null)).toBe(false);
    expect(canMessageMember(undefined)).toBe(false);
  });
});

describe('withoutInvitees', () => {
  it('keeps only the members who have joined, in order', () => {
    expect(withoutInvitees([ann, bob, cat, dan])).toEqual([ann, cat]);
  });
});

describe('inviteesLast', () => {
  it('moves invitees to the end and keeps the order otherwise', () => {
    expect(inviteesLast([bob, ann, dan, cat])).toEqual([ann, cat, bob, dan]);
  });
});

describe('isInvitationPendingError', () => {
  const body = (reason: string) => ({ error: { code: 'CONFLICT', message: 'x', details: { reason } } });

  it("recognises chat-api's 409 for an invitee", () => {
    expect(isInvitationPendingError(new ApiError('x', 409, body('invitation_pending')))).toBe(true);
  });

  it('ignores other conflicts and other errors', () => {
    expect(isInvitationPendingError(new ApiError('x', 409, body('something_else')))).toBe(false);
    expect(isInvitationPendingError(new ApiError('x', 409))).toBe(false);
    expect(isInvitationPendingError(new ApiError('x', 404, body('invitation_pending')))).toBe(false);
    expect(isInvitationPendingError(new Error('x'))).toBe(false);
    expect(isInvitationPendingError(null)).toBe(false);
  });
});
