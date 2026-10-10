/**
 * Workspace restrictions (licensed apps + read-only) and the read-only request
 * rule shared by every first-party API worker.
 */

import { describe, it, expect } from 'vitest';
import {
  computeWorkspaceRestrictions,
  isReadOnlyRequestAllowed,
  workspaceReadOnlyBody,
} from './read-only';

const licence = (status: string, allowedApps: string[] = ['welddesk']) => ({ status, allowedApps });

describe('computeWorkspaceRestrictions', () => {
  it('leaves direct workspaces unrestricted, whatever else is set', () => {
    expect(
      computeWorkspaceRestrictions({ billingMode: 'direct', licence: null, partnerStatus: null }),
    ).toEqual({ licensedApps: null, readOnly: false, readOnlyReason: null });
    // Stale licence / partner data on a direct workspace (e.g. after detach) is ignored.
    expect(
      computeWorkspaceRestrictions({
        billingMode: 'direct',
        licence: licence('ended'),
        partnerStatus: 'suspended',
      }),
    ).toEqual({ licensedApps: null, readOnly: false, readOnlyReason: null });
    expect(
      computeWorkspaceRestrictions({ billingMode: undefined, licence: null, partnerStatus: null }).licensedApps,
    ).toBeNull();
  });

  it('licenses a partner workspace for its licence apps and keeps it writable while all is well', () => {
    expect(
      computeWorkspaceRestrictions({
        billingMode: 'partner',
        licence: licence('active', ['welddesk', 'weldcrm']),
        partnerStatus: 'active',
      }),
    ).toEqual({ licensedApps: ['welddesk', 'weldcrm'], readOnly: false, readOnlyReason: null });
  });

  it('keeps a past_due partner writable (only suspension blocks)', () => {
    expect(
      computeWorkspaceRestrictions({ billingMode: 'partner', licence: licence('active'), partnerStatus: 'past_due' })
        .readOnly,
    ).toBe(false);
  });

  it('is read-only with reason partner_suspended when the partner is suspended', () => {
    expect(
      computeWorkspaceRestrictions({ billingMode: 'partner', licence: licence('active'), partnerStatus: 'suspended' }),
    ).toEqual({ licensedApps: ['welddesk'], readOnly: true, readOnlyReason: 'partner_suspended' });
  });

  it('is read-only with reason licence_inactive when the licence is suspended or ended', () => {
    for (const status of ['suspended', 'ended']) {
      expect(
        computeWorkspaceRestrictions({ billingMode: 'partner', licence: licence(status), partnerStatus: 'active' }),
      ).toEqual({ licensedApps: ['welddesk'], readOnly: true, readOnlyReason: 'licence_inactive' });
    }
  });

  it('reports partner_suspended when both apply', () => {
    expect(
      computeWorkspaceRestrictions({ billingMode: 'partner', licence: licence('ended'), partnerStatus: 'suspended' })
        .readOnlyReason,
    ).toBe('partner_suspended');
  });

  it('treats a partner workspace without a licence row as core-only and read-only', () => {
    expect(computeWorkspaceRestrictions({ billingMode: 'partner', licence: null, partnerStatus: 'active' })).toEqual({
      licensedApps: [],
      readOnly: true,
      readOnlyReason: 'licence_inactive',
    });
  });

  it('copies the app list rather than sharing the row array', () => {
    const apps = ['welddesk'];
    const out = computeWorkspaceRestrictions({
      billingMode: 'partner',
      licence: { status: 'active', allowedApps: apps },
      partnerStatus: 'active',
    });
    expect(out.licensedApps).not.toBe(apps);
  });
});

describe('isReadOnlyRequestAllowed', () => {
  it('allows reads', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(isReadOnlyRequestAllowed(method, '/api/tickets')).toBe(true);
    }
  });

  it('refuses every write method on ordinary paths', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isReadOnlyRequestAllowed(method, '/api/tickets/t_1'), method).toBe(false);
    }
  });

  it('allows the read-style POSTs: search and export', () => {
    expect(isReadOnlyRequestAllowed('POST', '/api/search')).toBe(true);
    expect(isReadOnlyRequestAllowed('POST', '/api/search/global')).toBe(true);
    expect(isReadOnlyRequestAllowed('POST', '/api/tickets/export')).toBe(true);
    expect(isReadOnlyRequestAllowed('POST', '/api/crm/companies/export/csv')).toBe(true);
    expect(isReadOnlyRequestAllowed('POST', '/v1/customers/export')).toBe(true);
  });

  it('allows the user-level core paths', () => {
    for (const path of ['/api/me', '/api/me/avatar', '/api/user-preferences', '/api/notification-preferences', '/api/push-tokens']) {
      expect(isReadOnlyRequestAllowed('PUT', path), path).toBe(true);
    }
  });

  it('matches prefixes on a segment boundary', () => {
    expect(isReadOnlyRequestAllowed('POST', '/api/members')).toBe(false);
    expect(isReadOnlyRequestAllowed('POST', '/api/meetings')).toBe(false);
    expect(isReadOnlyRequestAllowed('POST', '/api/search-index')).toBe(false);
    expect(isReadOnlyRequestAllowed('POST', '/api/chat-search')).toBe(false);
  });
});

describe('workspaceReadOnlyBody', () => {
  it('has the WORKSPACE_READ_ONLY shape with the reason in details', () => {
    for (const reason of ['partner_suspended', 'licence_inactive'] as const) {
      const body = workspaceReadOnlyBody(reason);
      expect(body.error.code).toBe('WORKSPACE_READ_ONLY');
      expect(body.error.details).toEqual({ reason });
      expect(body.error.message).toEqual(expect.any(String));
    }
  });

  it('defaults a missing reason to licence_inactive', () => {
    expect(workspaceReadOnlyBody(null).error.details).toEqual({ reason: 'licence_inactive' });
  });
});
