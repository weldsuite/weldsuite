
import { useEffect, useRef } from 'react';
import { useAuth, useOrganizationList, useOrganization } from '@clerk/clerk-react';
import { PageLoader } from '@/components/page-loader';
import { getTranslations } from '@/lib/i18n';

/**
 * This page handles Clerk's post-sign-up task redirects.
 * When Clerk auto-creates an organization or needs to complete setup tasks,
 * it redirects to /auth/register/tasks. This page catches those redirects and
 * properly routes the user to the right destination.
 */
export default function ClerkSignUpTasksPage() {
  const t = getTranslations('common');
  const { isSignedIn, isLoaded: authLoaded } = useAuth();
  const { organization, isLoaded: orgLoaded } = useOrganization();
  const { isLoaded: orgsLoaded, userMemberships, setActive } = useOrganizationList({
    userMemberships: true,
  });
  const redirectingRef = useRef(false);

  useEffect(() => {
    if (!authLoaded || !orgsLoaded || !orgLoaded || redirectingRef.current) return;

    // Not signed in - redirect to register
    if (!isSignedIn) {
      redirectingRef.current = true;
      window.location.href = '/auth/register';
      return;
    }

    const memberships = userMemberships?.data || [];

    // If user has organizations but no active one, set the first one as active
    if (memberships.length > 0 && !organization) {
      const firstOrg = memberships[0].organization;
      setActive?.({ organization: firstOrg.id })
        .then(() => {
          redirectingRef.current = true;
          window.location.href = '/';
        })
        .catch((err) => {
          console.error('Failed to set active organization:', err);
          // Still redirect to dashboard, let it handle the state
          redirectingRef.current = true;
          window.location.href = '/';
        });
      return;
    }

    // User has active organization - go to dashboard
    if (organization) {
      redirectingRef.current = true;
      window.location.href = '/';
      return;
    }

    // User has no organizations - go to onboarding
    if (memberships.length === 0) {
      redirectingRef.current = true;
      window.location.href = '/onboarding';
      return;
    }
  }, [authLoaded, orgsLoaded, orgLoaded, isSignedIn, organization, userMemberships, setActive]);

  return <PageLoader label={t.auth.tasks.settingUpAccount} />;
}
