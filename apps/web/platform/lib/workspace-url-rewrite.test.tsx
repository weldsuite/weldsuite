import { beforeEach, describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';
import {
  Link,
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useRouterState,
} from '@tanstack/react-router';
import {
  getWorkspaceUrlState,
  resetWorkspaceUrlStateForTests,
  setActiveWorkspaceRef,
  toPublicPath,
  workspaceUrlRewrite,
} from './workspace-url-rewrite';

// The router contract this module relies on (FE-013 spike, router 1.160).

// <Link> is typed against the app's registered route tree; this test has its own.
const TestLink = Link as unknown as (props: Record<string, unknown> & { children?: ReactNode }) => ReactNode;

function Probe() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <div>
      <span data-testid="pathname">{pathname}</span>
      <TestLink to="/settings/billing" data-testid="link-billing">
        billing
      </TestLink>
      <TestLink to="/weldcrm/customers/$id" params={{ id: 'cus_1' }} search={{ tab: 'notes' }} hash="n1" data-testid="link-cus">
        cus
      </TestLink>
      <TestLink to="/auth/login" data-testid="link-auth">
        auth
      </TestLink>
      <Outlet />
    </div>
  );
}

function setup(initial: string) {
  const root = createRootRoute({ component: Probe });
  const page = (path: string, text: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => <p>{text}</p> });
  const old = createRoute({
    getParentRoute: () => root,
    path: '/old',
    beforeLoad: () => {
      throw redirect({ to: '/settings/billing' });
    },
  });
  const history = createMemoryHistory({ initialEntries: [initial] });
  const router = createRouter({
    routeTree: root.addChildren([
      page('/', 'page:home'),
      page('/weldcrm/customers', 'page:customers'),
      page('/weldcrm/customers/$id', 'page:customer'),
      page('/settings/billing', 'page:billing'),
      page('/auth/login', 'page:login'),
      old,
    ]),
    history,
    rewrite: workspaceUrlRewrite,
  });
  render(<RouterProvider router={router} />);
  return { router, history };
}

const text = (id: string) => screen.getByTestId(id).textContent;
const href = (id: string) => screen.getByTestId(id).getAttribute('href');

beforeEach(() => {
  resetWorkspaceUrlStateForTests();
  setActiveWorkspaceRef('acme');
});

describe('workspaceUrlRewrite', () => {
  it('loads a prefixed URL on the bare route and remembers the ref', async () => {
    const { router, history } = setup('/w/acme/weldcrm/customers');
    expect(await screen.findByText('page:customers')).toBeTruthy();
    expect(text('pathname')).toBe('/weldcrm/customers');
    expect(router.state.location.publicHref).toBe('/w/acme/weldcrm/customers');
    expect(history.location.pathname).toBe('/w/acme/weldcrm/customers');
    expect(getWorkspaceUrlState().urlRef).toBe('acme');
  });

  it('prefixes workspace links, keeping params, search and hash, and not others', async () => {
    setup('/w/acme/');
    await screen.findByText('page:home');
    expect(href('link-billing')).toBe('/w/acme/settings/billing');
    expect(href('link-cus')).toBe('/w/acme/weldcrm/customers/cus_1?tab=notes#n1');
    expect(href('link-auth')).toBe('/auth/login');
  });

  it('keeps links bare until the shell has settled the workspace', async () => {
    resetWorkspaceUrlStateForTests();
    setup('/weldcrm/customers');
    await screen.findByText('page:customers');
    expect(href('link-billing')).toBe('/settings/billing');
  });

  it('commits prefixed URLs for clicks, navigate({ to }), navigate({ href }) and redirects', async () => {
    const { router, history } = setup('/w/acme/');
    await screen.findByText('page:home');
    await act(async () => {
      screen.getByTestId('link-billing').click();
    });
    expect(await screen.findByText('page:billing')).toBeTruthy();
    expect(history.location.pathname).toBe('/w/acme/settings/billing');

    await act(() => router.navigate({ href: '/weldcrm/customers?x=1' }));
    expect(history.location.pathname).toBe('/w/acme/weldcrm/customers');
    expect(history.location.search).toBe('?x=1');

    await act(() => router.navigate({ href: '/w/acme/old' }));
    expect(await screen.findByText('page:billing')).toBeTruthy();
    expect(history.location.pathname).toBe('/w/acme/settings/billing');
    expect(text('pathname')).toBe('/settings/billing');
  });

  it('routes an in-app `to` that already names a workspace, without a /w route', async () => {
    const { router, history } = setup('/w/acme/');
    await screen.findByText('page:home');
    // A stored return path with the prefix, pushed through `to` (not `href`).
    await act(() => router.navigate({ to: '/w/globex/settings/billing' } as never));
    expect(await screen.findByText('page:billing')).toBeTruthy();
    expect(history.location.pathname).toBe('/w/globex/settings/billing');
    expect(getWorkspaceUrlState().urlRef).toBe('globex');
  });

  it('goes back through input', async () => {
    const { router, history } = setup('/w/acme/weldcrm/customers');
    await screen.findByText('page:customers');
    await act(() => router.navigate({ to: '/settings/billing' }));
    await screen.findByText('page:billing');
    await act(async () => {
      history.back();
    });
    expect(await screen.findByText('page:customers')).toBeTruthy();
  });

  it('builds the internal and public href separately', async () => {
    const { router } = setup('/w/acme/');
    await screen.findByText('page:home');
    const location = router.buildLocation({ to: '/settings/billing' });
    expect(location.href).toBe('/settings/billing');
    expect(location.publicHref).toBe('/w/acme/settings/billing');
  });

  it('swaps an org id for the slug when the shell replaces the URL', async () => {
    const { router, history } = setup('/w/org_acme/weldcrm/customers');
    await screen.findByText('page:customers');
    expect(getWorkspaceUrlState().urlRef).toBe('org_acme');
    // What the gate does: same-location navigate() never writes history.
    await act(async () => {
      router.history.replace('/w/acme' + router.state.location.href, router.history.location.state);
    });
    expect(history.location.pathname).toBe('/w/acme/weldcrm/customers');
    expect(getWorkspaceUrlState().urlRef).toBe('acme');
  });
});

describe('toPublicPath', () => {
  it('prefixes workspace paths with the active ref', () => {
    expect(toPublicPath('/weldmail/inbox?x=1#y')).toBe('/w/acme/weldmail/inbox?x=1#y');
    expect(toPublicPath('/')).toBe('/w/acme/');
  });

  it('leaves other paths and URLs alone', () => {
    expect(toPublicPath('/auth/login')).toBe('/auth/login');
    expect(toPublicPath('/w/globex/x')).toBe('/w/globex/x');
    expect(toPublicPath('https://example.com/x')).toBe('https://example.com/x');
    expect(toPublicPath('//evil.example')).toBe('//evil.example');
  });

  it('is a no-op before the workspace is settled', () => {
    expect(toPublicPath('/weldcrm', null)).toBe('/weldcrm');
  });
});
