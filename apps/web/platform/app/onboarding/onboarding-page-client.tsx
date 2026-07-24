
import { useEffect, useState } from 'react';
import { useAuth, useUser, useOrganizationList } from '@clerk/clerk-react';
import { PageLoader } from '@/components/page-loader';
import { track } from '@/lib/analytics';
import {
  useOnboardingStatus,
  useDatabaseStatus,
  useUserAndOrgInfo,
  useAvailableApps,
} from '@/hooks/use-onboarding';
import { OnboardingWizard } from './components/onboarding-wizard';
import { ProvisioningScreen } from './components/provisioning-screen';
import { getDefaultRegionForCountry } from './types';

export function OnboardingPageClient({ detectedCountry }: { detectedCountry: string }) {
  const { orgId, isLoaded } = useAuth();
  const { user } = useUser();
  // Invitees sign up with an existing org membership but Clerk doesn't always
  // activate it on the session — without this, useAuth().orgId is undefined
  // and they'd be shown the full wizard despite already belonging to an org.
  const orgList = useOrganizationList({ userMemberships: true });
  const [isActivatingOrg, setIsActivatingOrg] = useState(false);

  useEffect(() => {
    if (!isLoaded || orgId) return;
    const memberships = orgList.userMemberships?.data;
    if (!memberships || memberships.length === 0) return;
    if (!orgList.setActive) return;
    setIsActivatingOrg(true);
    orgList.setActive({ organization: memberships[0].organization.id })
      .then(() => { window.location.href = '/'; })
      .catch(() => { setIsActivatingOrg(false); });
    // orgList is a new object every render; depending on the whole object
    // would re-run this effect on every render instead of only on data change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, orgId, orgList.userMemberships?.data, orgList.setActive]);

  useEffect(() => {
    if (isLoaded && !orgId) {
      track('Onboarding Started');
    }
  }, [isLoaded, orgId]);

  // Only check database status if org exists
  const { data: dbStatus } = useDatabaseStatus(!!orgId);
  const { data: onboardingStatus, isLoading: isLoadingStatus } = useOnboardingStatus();
  const { data: userInfo } = useUserAndOrgInfo(!orgId);
  const { data: availableApps, isLoading: isLoadingApps } = useAvailableApps();

  if (!isLoaded || isLoadingStatus || isActivatingOrg) {
    return <PageLoader />;
  }

  // Wait for membership list before deciding which screen to show — otherwise
  // an invitee briefly sees the wizard before the auto-activate kicks in.
  if (!orgId && !orgList.isLoaded) {
    return <PageLoader />;
  }
  if (!orgId && (orgList.userMemberships?.data?.length ?? 0) > 0) {
    return <PageLoader />;
  }

  // If org exists, check DB status
  if (orgId) {
    if (dbStatus?.provisioned && dbStatus?.migrated && onboardingStatus?.completed) {
      // Already completed - redirect
      window.location.href = '/';
      return null;
    }
    return <ProvisioningScreen />;
  }

  // No org yet - show wizard
  const defaultRegion = getDefaultRegionForCountry(detectedCountry);
  const userInfoData = {
    user: {
      firstName: user?.firstName || '',
      lastName: user?.lastName || '',
      email: user?.primaryEmailAddress?.emailAddress || '',
      imageUrl: user?.imageUrl || undefined,
    },
    organization: userInfo?.organization || null,
  };

  if (isLoadingApps) {
    return <PageLoader />;
  }

  return (
    <OnboardingWizard
      initialUserInfo={userInfoData.user}
      initialOrgInfo={userInfoData.organization}
      availableApps={availableApps || []}
      detectedCountry={detectedCountry}
      defaultRegion={defaultRegion}
    />
  );
}
