import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

let search: Record<string, unknown> = {};

vi.mock('@tanstack/react-router', () => ({
  useLocation: ({ select }: { select: (location: { search: Record<string, unknown> }) => unknown }) => select({ search }),
}));

const { SignInScreen, signInRedirect, useSignOut } = await import('./auth-client');
const { adminCopy } = await import('./i18n');

afterEach(() => {
  search = {};
  vi.unstubAllGlobals();
});

describe('signInRedirect', () => {
  it('sends the browser to the sign-in endpoint with the page to return to', () => {
    expect(signInRedirect('/workspaces?q=a b')).toEqual({
      href: '/auth/sign-in?redirect_url=%2Fworkspaces%3Fq%3Da%20b',
      reloadDocument: true,
    });
  });
});

describe('SignInScreen', () => {
  const t = adminCopy().signIn;
  const render = () => renderToStaticMarkup(createElement(SignInScreen));

  it('explains the sign-in and links back to the page asked for', () => {
    search = { redirect_url: '/plans' };
    const html = render();
    expect(html).toContain(t.title);
    expect(html).toContain('href="/auth/sign-in?redirect_url=%2Fplans"');
  });

  it('says so when signing in failed, and returns to the dashboard by default', () => {
    search = { error: 'access_denied' };
    const html = render();
    expect(html).toContain(renderToStaticMarkup(createElement('p', null, t.failed)).slice(3, -4));
    expect(html).toContain('href="/auth/sign-in?redirect_url=%2F"');
  });

  it('confirms a sign-out', () => {
    search = { signed_out: '1' };
    expect(render()).toContain(t.signedOut);
  });
});

describe('useSignOut', () => {
  it('posts a form to the sign-out endpoint', () => {
    const form = { method: '', action: '', submit: vi.fn() };
    const appendChild = vi.fn();
    vi.stubGlobal('document', { createElement: vi.fn(() => form), body: { appendChild } });
    let signOut: (() => void) | undefined;
    function Probe() {
      signOut = useSignOut();
      return null;
    }
    renderToStaticMarkup(createElement(Probe));
    signOut?.();
    expect(form).toMatchObject({ method: 'POST', action: '/auth/sign-out' });
    expect(appendChild).toHaveBeenCalledWith(form);
    expect(form.submit).toHaveBeenCalledOnce();
  });
});
