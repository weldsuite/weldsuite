import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { Loader2, CheckCircle2, AlertTriangle, ExternalLink } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { getTranslations } from '@/lib/i18n';

type Phase = 'minting' | 'redirecting' | 'error' | 'done';

/**
 * Runs in the user's **system browser** after the platform completes a Clerk
 * sign-in for a `?desktop=1` flow. Mints a single-use sign-in ticket and
 * redirects to `weldsuite://auth?ticket=...` so the desktop Electron shell
 * can complete the session without re-authenticating inside the webview.
 *
 * This page is **never** expected to render inside the Electron shell — the
 * shell's navigation interceptor keeps /auth/* in the browser.
 */
export default function DesktopHandoffPage() {
  const t = getTranslations('common');
  const { isLoaded, isSignedIn } = useAuth();
  const { getClient } = useAppApiClient();
  const [phase, setPhase] = useState<Phase>('minting');
  const [error, setError] = useState<string | null>(null);
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);

  const params = new URLSearchParams(window.location.search);
  const returnTo = validateReturnTo(params.get('return_to'));

  useEffect(() => {
    if (!isLoaded) return;

    if (!isSignedIn) {
      // Not signed in — bounce to login with the same desktop params preserved.
      const loginUrl = new URL('/auth/login', window.location.origin);
      loginUrl.searchParams.set('desktop', '1');
      loginUrl.searchParams.set('callbackUrl', `/auth/desktop-handoff?return_to=${encodeURIComponent(returnTo)}`);
      window.location.replace(loginUrl.toString());
      return;
    }

    (async () => {
      try {
        const client = await getClient();
        const res = await client.post<{
          data: { ticket: string; expiresAt: number; returnTo: string };
        }>('/auth-desktop/ticket', { returnTo });
        const ticket = res?.data?.ticket;
        if (!ticket) throw new Error('No ticket returned from server.');

        const url = new URL(returnTo);
        url.searchParams.set('status', 'success');
        url.searchParams.set('ticket', ticket);
        setRedirectUrl(url.toString());
        setPhase('redirecting');
        window.location.href = url.toString();
        // Give the OS a moment to handle the protocol — then show the fallback button.
        setTimeout(() => setPhase('done'), 1500);
      } catch (err) {
        setError(err instanceof Error ? err.message : t.auth.desktop.error.failedToComplete);
        setPhase('error');
      }
    })();
  }, [isLoaded, isSignedIn, returnTo, getClient, t.auth.desktop.error.failedToComplete]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-white px-6">
      <div className="w-full max-w-md text-center space-y-6">
        <div className="flex justify-center">
          {phase === 'error' ? (
            <div className="h-14 w-14 rounded-full bg-red-50 flex items-center justify-center text-red-600">
              <AlertTriangle className="h-7 w-7" />
            </div>
          ) : phase === 'done' ? (
            <div className="h-14 w-14 rounded-full bg-green-50 flex items-center justify-center text-green-600">
              <CheckCircle2 className="h-7 w-7" />
            </div>
          ) : (
            <div className="h-14 w-14 rounded-full bg-gray-50 flex items-center justify-center">
              <Loader2 className="h-7 w-7 animate-spin text-gray-500" />
            </div>
          )}
        </div>

        {phase === 'minting' && (
          <>
            <h1 className="text-xl font-semibold text-gray-900">{t.auth.desktop.minting.title}</h1>
            <p className="text-sm text-gray-600">
              {t.auth.desktop.minting.subtitle}
            </p>
          </>
        )}

        {phase === 'redirecting' && (
          <>
            <h1 className="text-xl font-semibold text-gray-900">{t.auth.desktop.redirecting.title}</h1>
            <p className="text-sm text-gray-600">
              {t.auth.desktop.redirecting.subtitle}
            </p>
            {redirectUrl && (
              <Button asChild>
                <a href={redirectUrl}>
                  <ExternalLink className="h-4 w-4 mr-2" />
                  {t.auth.desktop.redirecting.openApp}
                </a>
              </Button>
            )}
          </>
        )}

        {phase === 'done' && (
          <>
            <h1 className="text-xl font-semibold text-gray-900">{t.auth.desktop.done.title}</h1>
            <p className="text-sm text-gray-600">
              {t.auth.desktop.done.subtitle}
            </p>
            {redirectUrl && (
              <Button asChild variant="outline">
                <a href={redirectUrl}>{t.auth.desktop.done.openApp}</a>
              </Button>
            )}
          </>
        )}

        {phase === 'error' && (
          <>
            <h1 className="text-xl font-semibold text-gray-900">{t.auth.desktop.error.title}</h1>
            <p className="text-sm text-red-600">{error}</p>
            <Button onClick={() => window.location.reload()}>{t.auth.desktop.error.tryAgain}</Button>
          </>
        )}
      </div>
    </div>
  );
}

const ALLOWED_SCHEMES = ['weldsuite:'];

function validateReturnTo(raw: string | null): string {
  const fallback = 'weldsuite://auth';
  if (!raw) return fallback;
  try {
    const u = new URL(raw);
    if (!ALLOWED_SCHEMES.includes(u.protocol)) return fallback;
    return u.toString();
  } catch {
    return fallback;
  }
}
