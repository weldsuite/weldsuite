import { describe, expect, it } from 'vitest';
import { decideWorkspaceUrl, type WorkspaceUrlGateInput } from './workspace-url-gate';

const memberships = [
  { id: 'org_acme', slug: 'acme' },
  { id: 'org_globex', slug: 'globex' },
  { id: 'org_noslug', slug: null },
];

const base: WorkspaceUrlGateInput = {
  urlRef: 'acme',
  orgId: 'org_acme',
  orgSlug: 'acme',
  pendingOrgId: null,
  memberships: null,
};

const decide = (overrides: Partial<WorkspaceUrlGateInput>) => decideWorkspaceUrl({ ...base, ...overrides });

describe('decideWorkspaceUrl', () => {
  it('renders when the URL names the active workspace, by slug or org id', () => {
    expect(decide({})).toEqual({ kind: 'ready', ref: 'acme' });
    expect(decide({ urlRef: 'ACME' })).toEqual({ kind: 'ready', ref: 'acme' });
    expect(decide({ urlRef: 'org_acme' })).toEqual({ kind: 'ready', ref: 'acme' });
  });

  it('uses the org id when the workspace has no slug', () => {
    expect(decide({ urlRef: 'org_noslug', orgId: 'org_noslug', orgSlug: null })).toEqual({
      kind: 'ready',
      ref: 'org_noslug',
    });
  });

  it('settles a bare path on the active workspace, or leaves it to the shell without one', () => {
    expect(decide({ urlRef: null })).toEqual({ kind: 'ready', ref: 'acme' });
    expect(decide({ urlRef: null, orgId: null, orgSlug: null })).toEqual({ kind: 'skip' });
  });

  it('waits for the memberships when the URL names another workspace', () => {
    expect(decide({ urlRef: 'globex' })).toEqual({ kind: 'wait' });
  });

  it('activates another of the user workspaces', () => {
    expect(decide({ urlRef: 'globex', memberships })).toEqual({ kind: 'activate', orgId: 'org_globex' });
    expect(decide({ urlRef: 'org_globex', memberships })).toEqual({ kind: 'activate', orgId: 'org_globex' });
    expect(decide({ urlRef: 'acme', orgId: null, orgSlug: null, memberships })).toEqual({
      kind: 'activate',
      orgId: 'org_acme',
    });
  });

  it('never falls back to the active workspace for one the user is not in', () => {
    expect(decide({ urlRef: 'initech', memberships })).toEqual({ kind: 'not-found' });
  });

  it('activates a just-created workspace from its own link, before it is listed', () => {
    expect(decide({ urlRef: 'org_new', pendingOrgId: 'org_new' })).toEqual({ kind: 'activate', orgId: 'org_new' });
    expect(decide({ urlRef: 'org_new', pendingOrgId: 'org_new', orgId: 'org_new', orgSlug: null })).toEqual({
      kind: 'ready',
      ref: 'org_new',
    });
  });

  it('accepts a renamed slug while the session claim still has the old one', () => {
    const renamed = [{ id: 'org_acme', slug: 'acme-bv' }];
    expect(decide({ urlRef: 'acme-bv', memberships: renamed })).toEqual({ kind: 'ready', ref: 'acme-bv' });
  });
});
