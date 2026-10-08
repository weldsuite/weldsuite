/**
 * Unit tests for the mapping of a failed "add existing Clerk user as guest"
 * call to the API error. Codes are Clerk's documented Backend API names:
 * organization_membership_quota_exceeded (403), already_a_member_in_organization (400).
 */

import { describe, it, expect } from 'vitest';
import { clerkCapWithRoomForOne, describeGuestAddFailure } from './index';

describe('describeGuestAddFailure', () => {
  it('maps the membership quota to forbidden with a member-limit message', () => {
    const result = describeGuestAddFailure({
      status: 'failed',
      httpStatus: 403,
      code: 'organization_membership_quota_exceeded',
      message: 'quota',
    });
    expect(result.kind).toBe('forbidden');
    expect(result.message).toMatch(/member limit/i);
  });

  it('maps a max_allowed_memberships code to forbidden as well', () => {
    expect(
      describeGuestAddFailure({ status: 'failed', httpStatus: 403, code: 'max_allowed_memberships' }).kind,
    ).toBe('forbidden');
  });

  it('maps an existing membership to conflict', () => {
    const result = describeGuestAddFailure({
      status: 'failed',
      httpStatus: 400,
      code: 'already_a_member_in_organization',
    });
    expect(result.kind).toBe('conflict');
  });

  it("falls back to the generic error and passes Clerk's message through", () => {
    const result = describeGuestAddFailure({
      status: 'failed',
      httpStatus: 422,
      code: 'something_else',
      message: 'Clerk says no',
    });
    expect(result).toEqual({
      kind: 'internal',
      message: 'Failed to add guest to Clerk organization: Clerk says no',
    });
  });

  it('keeps the plain generic message when Clerk gave none', () => {
    expect(describeGuestAddFailure({ status: 'failed', httpStatus: 500 })).toEqual({
      kind: 'internal',
      message: 'Failed to add guest to Clerk organization',
    });
  });
});

describe('clerkCapWithRoomForOne', () => {
  it('leaves an organization without a cap alone', () => {
    expect(clerkCapWithRoomForOne(null, 5)).toBeNull();
    expect(clerkCapWithRoomForOne(0, 5)).toBeNull();
  });

  it('leaves the cap alone while there is room', () => {
    expect(clerkCapWithRoomForOne(10, 9)).toBeNull();
  });

  it('raises a full cap by one, so a guest fits on a one-seat plan', () => {
    expect(clerkCapWithRoomForOne(1, 1)).toBe(2);
  });

  it('raises a cap that is already exceeded to one above what is in use', () => {
    expect(clerkCapWithRoomForOne(1, 3)).toBe(4);
  });
});
