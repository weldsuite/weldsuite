import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

interface FakeMembership {
  organization: { id: string; slug: string | null; name: string };
}

const clerk = vi.hoisted(() => ({
  orgId: 'org_acme' as string | null,
  orgSlug: 'acme' as string | null,
  memberships: [] as FakeMembership[],
  setActive: vi.fn(),
}));

const router = vi.hoisted(() => ({
  href: '/weldcrm/customers?tab=notes',
  history: { replace: vi.fn(), location: { state: { __TSR_index: 0 } } },
}));

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true, orgId: clerk.orgId, orgSlug: clerk.orgSlug }),
  useOrganizationList: () => ({
    isLoaded: true,
    setActive: clerk.setActive,
    userMemberships: {
      data: clerk.memberships,
      isLoading: false,
      isFetching: false,
      hasNextPage: false,
      fetchNext: vi.fn(),
    },
  }),
}));

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => router,
  useRouterState: ({ select }: { select: (s: { location: { href: string } }) => unknown }) =>
    select({ location: { href: router.href } }),
}));

import { useWorkspaceUrlGate } from './workspace-url-gate';
import {
  getWorkspaceUrlState,
  resetWorkspaceUrlStateForTests,
  workspaceUrlRewrite,
} from '@/lib/workspace-url-rewrite';

const ORIGIN = 'http://localhost:3000';
const realLocation = window.location;
let location: { pathname: string; search: string; hash: string; href: string; replace: ReturnType<typeof vi.fn> };

function membership(id: string, slug: string | null, name: string): FakeMembership {
  return { organization: { id, slug, name } };
}

/** Load `url` as the browser would: the address bar, then the router's input rewrite. */
function openUrl(url: string) {
  const parsed = new URL(url, ORIGIN);
  location = { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash, href: parsed.href, replace: vi.fn() };
  Object.defineProperty(window, 'location', { value: location, configurable: true, writable: true });
  workspaceUrlRewrite.input?.({ url: parsed });
}

async function renderGate(pathname = '/weldcrm/customers') {
  const hook = renderHook(() => useWorkspaceUrlGate(pathname));
  // Store notifications and the activation promise settle on microtasks.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return hook;
}

beforeEach(() => {
  resetWorkspaceUrlStateForTests();
  sessionStorage.clear();
  clerk.orgId = 'org_acme';
  clerk.orgSlug = 'acme';
  clerk.memberships = [membership('org_acme', 'acme', 'Acme'), membership('org_globex', 'globex', 'Globex')];
  clerk.setActive.mockReset().mockResolvedValue(undefined);
  router.href = '/weldcrm/customers?tab=notes';
  router.history.replace.mockReset();
});

afterEach(() => {
  Object.defineProperty(window, 'location', { value: realLocation, configurable: true, writable: true });
  vi.unstubAllEnvs();
});

describe('useWorkspaceUrlGate', () => {
  it('renders when the URL names the tab workspace, and links carry its slug', async () => {
    openUrl('/w/acme/weldcrm/customers?tab=notes');
    const { result } = await renderGate();
    expect(result.current.status).toBe('ready');
    expect(getWorkspaceUrlState().activeRef).toBe('acme');
    expect(router.history.replace).not.toHaveBeenCalled();
    expect(clerk.setActive).not.toHaveBeenCalled();
  });

  it('puts the slug in a bare URL, in place', async () => {
    openUrl('/weldcrm/customers?tab=notes');
    const { result } = await renderGate();
    expect(result.current.status).toBe('ready');
    expect(router.history.replace).toHaveBeenCalledWith('/w/acme/weldcrm/customers?tab=notes', expect.anything());
  });

  it('swaps an org id link for the slug', async () => {
    openUrl('/w/org_acme/weldcrm/customers?tab=notes');
    await renderGate();
    expect(router.history.replace).toHaveBeenCalledWith('/w/acme/weldcrm/customers?tab=notes', expect.anything());
    expect(clerk.setActive).not.toHaveBeenCalled();
  });

  it('switches the tab to the workspace the URL names, then reloads that URL', async () => {
    openUrl('/w/globex/weldcrm/customers');
    const { result } = await renderGate();
    expect(result.current.status).toBe('blocked');
    expect(clerk.setActive).toHaveBeenCalledWith({ organization: 'org_globex' });
    expect(location.replace).toHaveBeenCalledWith(`${ORIGIN}/w/globex/weldcrm/customers`);
    expect(sessionStorage.getItem('weldsuite:pending-org')).toBe('org_globex');
  });

  it('activates in place without an active org, and leaves no pending org behind', async () => {
    clerk.orgId = null;
    clerk.orgSlug = null;
    openUrl('/w/globex/weldcrm/customers');
    await renderGate();
    expect(clerk.setActive).toHaveBeenCalledWith({ organization: 'org_globex' });
    expect(location.replace).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('weldsuite:pending-org')).toBeNull();
  });

  it('shows the workspace list for a workspace the user is not in', async () => {
    openUrl('/w/initech/weldcrm/customers');
    const { result } = await renderGate();
    expect(result.current.status).toBe('not-found');
    expect(result.current.memberships.map((m) => m.slug)).toEqual(['acme', 'globex']);
    expect(clerk.setActive).not.toHaveBeenCalled();
  });

  it('reports a failed switch', async () => {
    clerk.setActive.mockRejectedValue(new Error('nope'));
    openUrl('/w/globex/weldcrm/customers');
    const { result } = await renderGate();
    expect(result.current.status).toBe('error');
  });

  it('stays out of pages outside a workspace, and with the kill switch off', async () => {
    openUrl('/w/globex/weldcrm/customers');
    expect((await renderGate('/onboarding')).result.current.status).toBe('off');
    vi.stubEnv('VITE_WORKSPACE_IN_URL', 'false');
    expect((await renderGate()).result.current.status).toBe('off');
    expect(clerk.setActive).not.toHaveBeenCalled();
  });
});
