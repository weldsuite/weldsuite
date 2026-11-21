/**
 * The desktop shell's sign-in through the system browser, as the OIDC session
 * sees it (`desktopBrowserSignIn`): feature-detected, so a browser and older
 * shells keep their sign-in, and every way a sign-in ends becomes a
 * `BrowserSignInError` the screen can word.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { BrowserSignInError } from '@/lib/auth/oidc/browser-sign-in';
import type { OidcSignInApi, OidcSignInOutcome, WeldsuiteDesktopApi } from '@/types/weldsuite-desktop';
import { desktopBrowserSignIn } from './desktop-auth';

function shell(outcome: OidcSignInOutcome, withSignIn = true) {
  const oidcSignIn: OidcSignInApi = {
    start: vi.fn(async () => ({ id: 'flow-1', redirectUri: 'http://127.0.0.1:53123/callback' })),
    authorize: vi.fn(async () => outcome),
    cancel: vi.fn(async () => true),
  };
  const openExternal = vi.fn(async () => true);
  window.weldsuiteDesktop = {
    isDesktop: true,
    openExternal,
    ...(withSignIn ? { oidcSignIn } : {}),
  } as unknown as WeldsuiteDesktopApi;
  return { oidcSignIn, openExternal };
}

afterEach(() => {
  delete window.weldsuiteDesktop;
});

describe('desktopBrowserSignIn', () => {
  it('is absent in a browser and in shells older than 0.3.0', () => {
    expect(desktopBrowserSignIn()).toBeNull();
    shell({ status: 'cancelled' }, false);
    expect(desktopBrowserSignIn()).toBeNull();
  });

  it('hands back the callback URL, and shows the browser its page in the platform’s language', async () => {
    const { oidcSignIn } = shell({ status: 'callback', callbackUrl: 'http://127.0.0.1:53123/callback?code=c&state=s' });
    const signIn = desktopBrowserSignIn();
    await expect(signIn?.start()).resolves.toEqual({ id: 'flow-1', redirectUri: 'http://127.0.0.1:53123/callback' });
    await expect(signIn?.authorize('flow-1', 'https://auth.example.eu/oauth/authorize?x')).resolves.toBe(
      'http://127.0.0.1:53123/callback?code=c&state=s',
    );
    expect(oidcSignIn.authorize).toHaveBeenCalledWith({
      id: 'flow-1',
      url: 'https://auth.example.eu/oauth/authorize?x',
      page: { lang: 'en', ...en.common.auth.desktop.browser.callback },
    });
  });

  it.each([
    [{ status: 'cancelled' }, 'cancelled'],
    [{ status: 'timeout' }, 'timeout'],
    [{ status: 'failed', reason: 'invalid_request' }, 'failed'],
    [{ status: 'failed', reason: 'browser' }, 'failed'],
  ] as const)('turns %o into a BrowserSignInError (%s)', async (outcome, reason) => {
    shell(outcome);
    const error = await desktopBrowserSignIn()
      ?.authorize('flow-1', 'https://auth.example.eu/oauth/authorize')
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(BrowserSignInError);
    expect((error as BrowserSignInError).reason).toBe(reason);
  });

  it('cancels by id and opens sign-out pages in the system browser', async () => {
    const { oidcSignIn, openExternal } = shell({ status: 'cancelled' });
    const signIn = desktopBrowserSignIn();
    await signIn?.cancel('flow-1');
    await signIn?.openExternal('https://auth.example.eu/oauth/logout?client_id=weldsuite-desktop');
    expect(oidcSignIn.cancel).toHaveBeenCalledWith('flow-1');
    expect(openExternal).toHaveBeenCalledWith('https://auth.example.eu/oauth/logout?client_id=weldsuite-desktop');
  });
});
