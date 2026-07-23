
import { useAuth } from '@clerk/clerk-react';
import { useRouter } from '@/lib/router';
import { useEffect, useMemo } from 'react';
import { PageLoader } from '@/components/page-loader';
import { OnboardingPageClient } from './onboarding-page-client';
import { detectUserCountry } from './types';

export default function OnboardingPage() {
  const { userId, isLoaded } = useAuth();
  const router = useRouter();

  // Default the country to the user's locale instead of hardcoding NL.
  const detectedCountry = useMemo(() => detectUserCountry(), []);

  useEffect(() => {
    if (isLoaded && !userId) {
      router.replace('/auth/login');
    }
  }, [isLoaded, userId, router]);

  if (!isLoaded || !userId) {
    return <PageLoader />;
  }

  return <OnboardingPageClient detectedCountry={detectedCountry} />;
}
