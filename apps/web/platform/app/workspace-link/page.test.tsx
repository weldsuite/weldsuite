import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

interface FakeMembership {
  organization: { id: string; slug: string | null; name: string };
}

const clerk = vi.hoisted(() => ({
  isSignedIn: true,
  orgId: 'org_acme' as string | null,
  memberships: [] as FakeMembership[],
  hasNextPage: false,
  fetchNext: vi.fn(),
  setActive: vi.fn(),
}));

const navigate = vi.hoisted(() => vi.fn());

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: clerk.isSignedIn, orgId: clerk.orgId }),
  useOrganizationList: () => ({
    isLoaded: true,
    setActive: clerk.setActive,
    userMemberships: {
      data: clerk.memberships,
      isLoading: false,
      isFetching: false,
      hasNextPage: clerk.hasNextPage,
      fetchNext: clerk.fetchNext,
    },
  }),
}));

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ navigate }),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: en, language: 'en' }) };
});

import WorkspaceLinkPage from './page';

const ORIGIN = 'http://localhost:3000';
const realLocation = window.location;
let location: { pathname: string; search: string; hash: string; origin: string; href: string; replace: ReturnType<typeof vi.fn> };

function membership(id: string, slug: string | null, name: string): FakeMembership {
  return { organization: { id, slug, name } };
}

function openLink(url: string) {
  const parsed = new URL(url, ORIGIN);
  location = {
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
    origin: ORIGIN,
    href: parsed.href,
    replace: vi.fn(),
  };
  Object.defineProperty(window, 'location', { value: location, configurable: true, writable: true });
}

async function renderPage() {
  render(<WorkspaceLinkPage />);
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  clerk.isSignedIn = true;
  clerk.orgId = 'org_acme';
  clerk.memberships = [membership('org_acme', 'acme', 'Acme'), membership('org_globex', 'globex', 'Globex')];
  clerk.hasNextPage = false;
  clerk.fetchNext.mockReset();
  clerk.setActive.mockReset().mockResolvedValue(undefined);
  navigate.mockReset();
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  Object.defineProperty(window, 'location', { value: realLocation, configurable: true, writable: true });
});

describe('WorkspaceLinkPage', () => {
  it('redirects in place when the link is for the active workspace', async () => {
    openLink('/w/acme/weldcrm/customers?tab=notes#n1');
    await renderPage();

    expect(navigate).toHaveBeenCalledWith({ href: '/weldcrm/customers?tab=notes#n1', replace: true });
    expect(clerk.setActive).not.toHaveBeenCalled();
  });

  it('switches this tab to the linked workspace, then reloads into the page', async () => {
    localStorage.setItem('weldsuite:query-cache', '{}');
    openLink('/w/globex/welddesk/tickets/tkt_1');
    await renderPage();

    expect(clerk.setActive).toHaveBeenCalledWith({ organization: 'org_globex' });
    expect(sessionStorage.getItem('weldsuite:pending-org')).toBe('org_globex');
    expect(localStorage.getItem('weldsuite:query-cache')).toBeNull();
    expect(location.replace).toHaveBeenCalledWith('/welddesk/tickets/tkt_1');
  });

  it('accepts a Clerk org id, as in links built by the backend', async () => {
    openLink('/w/org_globex/weldflow/tasks/t_9');
    await renderPage();

    expect(clerk.setActive).toHaveBeenCalledWith({ organization: 'org_globex' });
    expect(location.replace).toHaveBeenCalledWith('/weldflow/tasks/t_9');
  });

  it('loads further membership pages before deciding the workspace is unknown', async () => {
    clerk.hasNextPage = true;
    openLink('/w/initech/weldcrm');
    await renderPage();

    expect(clerk.fetchNext).toHaveBeenCalled();
    expect(screen.queryByText('Workspace not found')).toBeNull();
  });

  it('lists the user’s workspaces when the link points at one they are not in', async () => {
    openLink('/w/initech/weldcrm/customers?x=1');
    await renderPage();

    expect(screen.getByText('Workspace not found')).toBeTruthy();
    expect(screen.getByText('Acme').closest('a')?.getAttribute('href')).toBe('/w/acme/weldcrm/customers?x=1');
    expect(screen.getByText('Globex').closest('a')?.getAttribute('href')).toBe('/w/globex/weldcrm/customers?x=1');
    expect(clerk.setActive).not.toHaveBeenCalled();
  });

  it('never redirects off the origin', async () => {
    openLink('/w/acme//evil.example/path');
    await renderPage();

    expect(navigate).toHaveBeenCalledWith({ href: '/', replace: true });
  });

  it('sends a signed-out visitor to sign in and back to the link', async () => {
    clerk.isSignedIn = false;
    openLink('/w/acme/weldcrm?x=1');
    await renderPage();

    expect(location.href).toBe(`/auth/login?callbackUrl=${encodeURIComponent('/w/acme/weldcrm?x=1')}`);
  });

  it('says so when switching workspace fails', async () => {
    clerk.setActive.mockRejectedValue(new Error('nope'));
    openLink('/w/globex/weldcrm');
    await renderPage();

    expect(screen.getByText("Couldn't open this workspace")).toBeTruthy();
    expect(location.replace).not.toHaveBeenCalled();
  });
});
