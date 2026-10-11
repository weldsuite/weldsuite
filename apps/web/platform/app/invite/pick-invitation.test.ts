import { describe, expect, it } from 'vitest';
import { pickInvitation } from './pick-invitation';

const invite = (id: string) => ({ publicOrganizationData: { id } });

describe('pickInvitation', () => {
  it('picks the invitation into the workspace the link names', () => {
    const invitations = [invite('org_old'), invite('org_new')];
    expect(pickInvitation(invitations, 'org_new')).toBe(invitations[1]);
  });

  it('returns nothing when no pending invitation is for that workspace', () => {
    expect(pickInvitation([invite('org_other')], 'org_new')).toBeUndefined();
  });

  it('falls back to the first pending invitation for links without a workspace', () => {
    const invitations = [invite('org_a'), invite('org_b')];
    expect(pickInvitation(invitations, undefined)).toBe(invitations[0]);
  });

  it('returns nothing without pending invitations', () => {
    expect(pickInvitation([], 'org_new')).toBeUndefined();
    expect(pickInvitation(undefined, undefined)).toBeUndefined();
  });
});
