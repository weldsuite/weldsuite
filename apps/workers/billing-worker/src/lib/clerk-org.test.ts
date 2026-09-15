import { describe, expect, it } from 'vitest';
import { orgIdFromClerkPayload, orgRoleFromClerkPayload } from './clerk-org';

describe('orgIdFromClerkPayload', () => {
  it('reads Clerk v2 o.id', () => {
    expect(orgIdFromClerkPayload({ o: { id: 'org_v2' } })).toBe('org_v2');
  });

  it('reads Clerk v1 org_id', () => {
    expect(orgIdFromClerkPayload({ org_id: 'org_v1' })).toBe('org_v1');
  });

  it('prefers o.id when both are present', () => {
    expect(orgIdFromClerkPayload({ org_id: 'org_v1', o: { id: 'org_v2' } })).toBe('org_v2');
  });

  it('returns null without an org claim', () => {
    expect(orgIdFromClerkPayload({ sub: 'user_1' } as never)).toBeNull();
  });
});

describe('orgRoleFromClerkPayload', () => {
  it('normalizes Clerk v2 o.rol to org:admin', () => {
    expect(orgRoleFromClerkPayload({ o: { rol: 'admin' } })).toBe('org:admin');
  });

  it('keeps Clerk v1 org_role', () => {
    expect(orgRoleFromClerkPayload({ org_role: 'org:member' })).toBe('org:member');
  });
});
