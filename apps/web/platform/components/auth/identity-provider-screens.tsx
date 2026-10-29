/**
 * What replaces WeldSuite's own sign-in screens when the identity provider
 * hosts them (OIDC, ADR SEC-012): the Clerk pages render these as their
 * `<ClerkOnly>` fallback.
 */

import { useEffect, useRef, useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { PageLoader } from '@/components/page-loader';
import { completeSignIn, getAccountUrl, redirectToSignIn } from '@/lib/auth';
import { getTranslations } from '@/lib/i18n';
import { useRouter } from '@/lib/router';

/** Only paths on this origin; anything else lands on the dashboard. */
function returnPath(): string {
  if (typeof window === 'undefined') return '/';
  const value = new URLSearchParams(window.location.search).get('redirect_url');
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/';
}

/** `/auth/login`, `/auth/register`, password reset: off to the provider's own page. */
export function HostedSignInRedirect({ intent = 'sign-in' }: Readonly<{ intent?: 'sign-in' | 'sign-up' }>) {
  const t = getTranslations('common');
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void redirectToSignIn({ intent, returnTo: returnPath() });
  }, [intent]);

  return <PageLoader label={t.auth.identityProvider.redirecting} />;
}

/** `/auth/sso-callback`: finish the provider's redirect, then continue where sign-in started. */
export function HostedSignInCallback() {
  const t = getTranslations('common');
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const handledRef = useRef(false);

  useEffect(() => {
    if (handledRef.current) return;
    handledRef.current = true;
    completeSignIn()
      .then((path) => router.replace(path))
      .catch(() => setFailed(true));
  }, [router]);

  if (!failed) return <PageLoader label={t.auth.identityProvider.completing} />;
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-4 text-center">
      <p className="text-sm text-muted-foreground">{t.auth.identityProvider.failed}</p>
      <Button onClick={() => void redirectToSignIn({ returnTo: '/' })}>{t.auth.identityProvider.retry}</Button>
    </div>
  );
}

/**
 * Account security (password, 2FA, passkeys, sessions) or workspace
 * invitations, when the provider owns them: say so, and link to the
 * provider's account page when the deployment names one.
 */
export function ManagedByIdentityProvider({ topic = 'account' }: Readonly<{ topic?: 'account' | 'invitations' }>) {
  const t = getTranslations('common');
  const accountUrl = getAccountUrl();
  const copy = t.auth.identityProvider;
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-3 p-6">
      <h2 className="text-lg font-semibold">{copy.managedTitle}</h2>
      <p className="text-sm text-muted-foreground">
        {topic === 'invitations' ? copy.invitationsManaged : copy.managedDescription}
      </p>
      {accountUrl && topic === 'account' ? (
        <div>
          <Button asChild variant="outline">
            <a href={accountUrl} target="_blank" rel="noreferrer">
              {copy.openAccount}
            </a>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
