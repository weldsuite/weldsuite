import { afterEach, describe, expect, it } from 'vitest';
import {
  clearPendingOrganization,
  peekPendingOrganization,
  resolveOrganizationToActivate,
  setPendingOrganization,
} from './pending-organization';

describe('pending organization storage', () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it('round-trips the org id through sessionStorage', () => {
    expect(peekPendingOrganization()).toBeNull();
    setPendingOrganization('org_new');
    expect(peekPendingOrganization()).toBe('org_new');
    clearPendingOrganization();
    expect(peekPendingOrganization()).toBeNull();
  });
});

describe('resolveOrganizationToActivate', () => {
  it('prefers a pending org over the current session org', () => {
    expect(
      resolveOrganizationToActivate({
        orgId: 'org_old',
        pendingOrgId: 'org_new',
        firstOrgId: 'org_old',
      }),
    ).toBe('org_new');
  });

  it('prefers a pending org when the session has no org', () => {
    expect(
      resolveOrganizationToActivate({
        orgId: null,
        pendingOrgId: 'org_new',
        firstOrgId: 'org_old',
      }),
    ).toBe('org_new');
  });

  it('does not re-activate when the session already has the pending org', () => {
    expect(
      resolveOrganizationToActivate({
        orgId: 'org_new',
        pendingOrgId: 'org_new',
        firstOrgId: 'org_old',
      }),
    ).toBeNull();
  });

  it('falls back to the first membership when nothing is pending and there is no session org', () => {
    expect(
      resolveOrganizationToActivate({
        orgId: null,
        pendingOrgId: null,
        firstOrgId: 'org_old',
      }),
    ).toBe('org_old');
  });

  it('returns null when the session already has an org and nothing is pending', () => {
    expect(
      resolveOrganizationToActivate({
        orgId: 'org_old',
        pendingOrgId: null,
        firstOrgId: 'org_old',
      }),
    ).toBeNull();
  });
});
