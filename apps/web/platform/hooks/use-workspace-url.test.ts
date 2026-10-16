import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const auth = vi.hoisted(() => ({ orgSlug: 'acme' as string | null, orgId: 'org_2Abc' as string | null }));

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => auth,
}));

import { useWorkspaceUrl } from './use-workspace-url';

const origin = window.location.origin;

function workspaceUrl(path: string) {
  return renderHook(() => useWorkspaceUrl()).result.current(path);
}

beforeEach(() => {
  auth.orgSlug = 'acme';
  auth.orgId = 'org_2Abc';
});

describe('useWorkspaceUrl', () => {
  it('links into the active workspace by slug', () => {
    expect(workspaceUrl('/settings/billing?credits=success')).toBe(`${origin}/w/acme/settings/billing?credits=success`);
  });

  it('falls back to the org id when the workspace has no slug', () => {
    auth.orgSlug = null;
    expect(workspaceUrl('/weldflow/task/t_1')).toBe(`${origin}/w/org_2Abc/weldflow/task/t_1`);
  });

  it('leaves a path that already names its workspace alone', () => {
    expect(workspaceUrl('/w/globex/weldconnect/connectors?x=1')).toBe(`${origin}/w/globex/weldconnect/connectors?x=1`);
  });

  it('gives the bare link without an active workspace', () => {
    auth.orgSlug = null;
    auth.orgId = null;
    expect(workspaceUrl('/weldchat/c1?msg=m1')).toBe(`${origin}/weldchat/c1?msg=m1`);
  });
});
