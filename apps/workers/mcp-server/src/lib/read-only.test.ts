/** The MCP server's copy of the workspace restriction rules (worker-kit has the original). */

import { describe, it, expect } from 'vitest';
import { isReadOnlyRequestAllowed, workspaceReadOnlyBody, workspaceRestrictions } from './read-only';

const base = { billingMode: 'partner', licenceStatus: 'active', licenceApps: ['welddesk'], partnerStatus: 'active' };

describe('workspaceRestrictions', () => {
  it('is unrestricted for direct workspaces', () => {
    expect(workspaceRestrictions({ ...base, billingMode: 'direct', partnerStatus: 'suspended' })).toEqual({
      licensedApps: null,
      readOnly: false,
      readOnlyReason: null,
    });
  });

  it('licenses a partner workspace for its apps and keeps it writable', () => {
    expect(workspaceRestrictions(base)).toEqual({ licensedApps: ['welddesk'], readOnly: false, readOnlyReason: null });
    expect(workspaceRestrictions({ ...base, partnerStatus: 'past_due' }).readOnly).toBe(false);
  });

  it('is read-only for a suspended partner or a non-active licence', () => {
    expect(workspaceRestrictions({ ...base, partnerStatus: 'suspended' })).toMatchObject({
      readOnly: true,
      readOnlyReason: 'partner_suspended',
    });
    for (const licenceStatus of ['suspended', 'ended']) {
      expect(workspaceRestrictions({ ...base, licenceStatus })).toMatchObject({
        readOnly: true,
        readOnlyReason: 'licence_inactive',
      });
    }
  });

  it('is core-only and read-only without a licence row', () => {
    expect(workspaceRestrictions({ ...base, licenceStatus: null, licenceApps: null })).toEqual({
      licensedApps: [],
      readOnly: true,
      readOnlyReason: 'licence_inactive',
    });
  });
});

describe('isReadOnlyRequestAllowed', () => {
  it('allows reads, exports and search; refuses other writes', () => {
    expect(isReadOnlyRequestAllowed('GET', '/v1/tickets')).toBe(true);
    expect(isReadOnlyRequestAllowed('POST', '/v1/tickets/export')).toBe(true);
    expect(isReadOnlyRequestAllowed('POST', '/v1/search')).toBe(true);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isReadOnlyRequestAllowed(method, '/v1/tickets/t_1'), method).toBe(false);
    }
  });

  it('has the WORKSPACE_READ_ONLY body shape', () => {
    expect(workspaceReadOnlyBody('partner_suspended').error).toMatchObject({
      code: 'WORKSPACE_READ_ONLY',
      details: { reason: 'partner_suspended' },
    });
    expect(workspaceReadOnlyBody(undefined).error.details).toEqual({ reason: 'licence_inactive' });
  });
});
