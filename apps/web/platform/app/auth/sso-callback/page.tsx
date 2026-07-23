
import { useEffect, useRef } from 'react';
import { useClerk, useAuth, useOrganizationList } from '@clerk/clerk-react';
import { PageLoader } from '@/components/page-loader';
import { getTranslations } from '@/lib/i18n';

export default function SSOCallbackPage() {
  const t = getTranslations('common');
  const { handleRedirectCallback } = useClerk();
  const { isSignedIn, isLoaded: authLoaded } = useAuth();
  const { isLoaded: orgsLoaded, userMemberships } = useOrganizationList({
    userMemberships: true,
  });
  const handledRef = useRef(false);
  const redirectedRef = useRef(false);

  // Handle the OAuth callback
  useEffect(() => {
    async function handleCallback() {
      if (handledRef.current) return;
      handledRef.current = true;

      try {
        // Handle the callback but don't let Clerk do its default redirect
        // because it will show the organization selection task
        await handleRedirectCallback({
          afterSignInUrl: '/auth/sso-callback',
          afterSignUpUrl: '/auth/sso-callback',
        });
      } catch (err) {
        console.error('SSO callback error:', err);
        window.location.href = '/auth/login?error=sso_failed';
      }
    }

    handleCallback();
  }, [handleRedirectCallback]);

  // Once authenticated, check org membership and redirect appropriately
  useEffect(() => {
    if (!authLoaded || !orgsLoaded || !isSignedIn || redirectedRef.current) return;

    redirectedRef.current = true;

    // Desktop handoff takes precedence — the Electron shell is waiting for a
    // deep-link callback, so we must always go through /auth/desktop-handoff
    // regardless of org-membership status.
    const query = new URLSearchParams(window.location.search);
    if (query.get('desktop') === '1') {
      const returnTo = query.get('return_to') ?? 'weldsuite://auth';
      const url = new URL('/auth/desktop-handoff', window.location.origin);
      url.searchParams.set('return_to', returnTo);
      window.location.href = url.toString();
      return;
    }

    // Check if user has any organizations
    const hasOrgs = userMemberships?.data && userMemberships.data.length > 0;

    if (hasOrgs) {
      // User has org, go to dashboard
      window.location.href = '/';
    } else {
      // No org, redirect to onboarding (our custom flow)
      window.location.href = '/onboarding';
    }
  }, [authLoaded, orgsLoaded, isSignedIn, userMemberships]);

  return <PageLoader label={t.auth.ssoCallback.completingSignIn} />;
}
