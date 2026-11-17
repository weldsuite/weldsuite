/**
 * Sign-in inside the desktop shell on an OIDC edition (EU, self-hosted): the
 * provider's pages open in the system browser, since Google and Microsoft
 * refuse sign-in inside an embedded window, and the shell takes the answer on
 * a loopback redirect (RFC 8252, `apps/desktop/docs/auth-handoff.md`).
 *
 * Started from the button, never on load: the desktop app also starts at
 * login, minimised, and must not open a browser tab by itself. `/auth/login`
 * and the provider's other entry points (`/auth/register`, password pages)
 * render this instead of sending the window to the provider.
 */

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ErrorBanner } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { BrowserSignInError, cancelBrowserSignIn, signInWithBrowser, useAuth } from '@/lib/auth';
import { sameOriginPath } from '@/lib/auth/same-origin-path';
import { getTranslations } from '@/lib/i18n';

export interface BrowserSignInScreenProps {
  intent?: 'sign-in' | 'sign-up';
  /** Where to land once signed in: a path on this origin. */
  returnTo: string;
}

export function BrowserSignInScreen({ intent = 'sign-in', returnTo }: Readonly<BrowserSignInScreenProps>) {
  const t = getTranslations('common');
  const copy = t.auth.desktop.browser;
  const { isLoaded, isSignedIn } = useAuth();
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already signed in (another window, a stale link): straight on, and only
  // ever to a path on this origin.
  useEffect(() => {
    if (isLoaded && isSignedIn && !waiting) {
      window.location.replace(`${window.location.origin}${sameOriginPath(returnTo)}`);
    }
  }, [isLoaded, isSignedIn, waiting, returnTo]);

  // Leaving the screen ends a sign-in still waiting in the browser.
  useEffect(() => () => cancelBrowserSignIn(), []);

  const start = async () => {
    setError(null);
    setWaiting(true);
    try {
      // Resolves signed in, with the page already on its way to `returnTo`.
      await signInWithBrowser({ intent, returnTo });
    } catch (err) {
      setWaiting(false);
      const reason = err instanceof BrowserSignInError ? err.reason : 'failed';
      if (reason === 'timeout') setError(copy.timedOut);
      else if (reason === 'failed') setError(copy.failed);
      // Cancelled: back to the button, nothing to say.
    }
  };

  if (!isLoaded || (isSignedIn && !waiting)) return <PageLoader label={t.auth.identityProvider.completing} />;

  return (
    <div className="min-h-screen bg-white flex">
      <div className="flex-1 flex flex-col justify-center px-8 py-12 lg:px-16">
        <div className="w-full max-w-[448px] mx-auto">
          <div className="mb-[32px]">
            <h1 className="text-[26px] font-semibold text-gray-900 mb-2">
              {intent === 'sign-up' ? copy.signUpTitle : copy.signInTitle}
            </h1>
            <p className="text-gray-600">{waiting ? copy.waitingHint : copy.subtitle}</p>
          </div>

          <ErrorBanner error={error} className="mb-4" />

          {waiting ? (
            <div className="space-y-3">
              <div className="flex h-[42px] items-center justify-center gap-2 text-[14px] text-gray-700" role="status">
                <Loader2 className="h-4 w-4 animate-spin" />
                {copy.waiting}
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => cancelBrowserSignIn()}
                className="w-full h-[42px] shadow-none text-[14px]"
              >
                {copy.cancel}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              onClick={() => void start()}
              className="w-full h-[42px] shadow-none rounded-[calc(var(--radius)+1px)] bg-black hover:bg-black/90 text-white text-[14px]"
              size="lg"
            >
              {copy.continue}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
