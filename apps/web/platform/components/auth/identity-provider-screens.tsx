/**
 * What replaces WeldSuite's own sign-in screens when the identity provider
 * hosts them (OIDC, ADR SEC-012): the Clerk pages render these as their
 * `<ClerkOnly>` fallback.
 */

import { useEffect, useRef, useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { completeSignIn, getAccountUrl, isWeldIdProvider, redirectToSignIn, usesBrowserSignIn } from '@/lib/auth';
import { sameOriginPath } from '@/lib/auth/same-origin-path';
import { getTranslations } from '@/lib/i18n';
import { useRouter } from '@/lib/router';
import { BrowserSignInScreen } from './browser-sign-in-screen';

/** Only paths on this origin; anything else lands on the dashboard. */
function returnPath(): string {
  if (typeof window === 'undefined') return '/';
  const params = new URLSearchParams(window.location.search);
  // `callbackUrl` is what the app shell sends a signed-out visitor with.
  return sameOriginPath(params.get('callbackUrl') ?? params.get('redirect_url'));
}

/**
 * `/auth/login`, `/auth/register`, password reset: off to the provider's own
 * page. Inside the desktop shell, the button that opens it in the system
 * browser instead.
 */
export function HostedSignInRedirect({ intent = 'sign-in' }: Readonly<{ intent?: 'sign-in' | 'sign-up' }>) {
  if (usesBrowserSignIn()) return <BrowserSignInScreen intent={intent} returnTo={returnPath()} />;
  return <RedirectToProvider intent={intent} />;
}

function RedirectToProvider({ intent }: Readonly<{ intent: 'sign-in' | 'sign-up' }>) {
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

type ManagedTopic = 'account' | 'invitations';
type IdentityProviderCopy = ReturnType<typeof getTranslations<'common'>>['auth']['identityProvider'];

/**
 * What the screen says. On WeldID, WeldSuite's own provider, the account
 * lives in WeldID, and invitations are WeldSuite's (membership mode), so a
 * link without one is incomplete rather than the provider's business.
 */
function managedCopy(topic: ManagedTopic, copy: IdentityProviderCopy) {
  if (isWeldIdProvider()) {
    const weldId = copy.weldId;
    return topic === 'invitations'
      ? { title: weldId.invitationIncompleteTitle, description: weldId.invitationIncomplete, openAccount: null }
      : { title: weldId.managedTitle, description: weldId.managedDescription, openAccount: weldId.openAccount };
  }
  return topic === 'invitations'
    ? { title: copy.managedTitle, description: copy.invitationsManaged, openAccount: null }
    : { title: copy.managedTitle, description: copy.managedDescription, openAccount: copy.openAccount };
}

/**
 * Account security (password, 2FA, passkeys, sessions) or workspace
 * invitations, when the provider owns them: say so, and link to the
 * provider's account page when the deployment names one.
 */
export function ManagedByIdentityProvider({ topic = 'account' }: Readonly<{ topic?: ManagedTopic }>) {
  const t = getTranslations('common');
  const accountUrl = getAccountUrl();
  const { title, description, openAccount } = managedCopy(topic, t.auth.identityProvider);
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-3 p-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">{description}</p>
      {accountUrl && openAccount ? (
        <div>
          <Button asChild variant="outline">
            <a href={accountUrl} target="_blank" rel="noreferrer">
              {openAccount}
            </a>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
