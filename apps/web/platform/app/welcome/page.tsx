
import { useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useRouter, useSearchParams } from '@/lib/router';
import { PageLoader } from '@/components/page-loader';
import { WelcomeClient } from './welcome-client';

export default function WelcomePage() {
  const { userId, orgId, isLoaded } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!isLoaded) return;

    // If user is authenticated with an organization, redirect to dashboard
    if (userId && orgId) {
      router.replace('/');
      return;
    }

    // If authenticated but no organization, redirect to onboarding
    if (userId && !orgId) {
      router.replace('/onboarding');
    }
  }, [isLoaded, userId, orgId, router]);

  if (!isLoaded || (userId && orgId) || (userId && !orgId)) {
    return <PageLoader />;
  }

  // Pass any error params
  const error = searchParams.get('error') ?? undefined;
  const errorDescription = searchParams.get('error_description') ?? undefined;

  return <WelcomeClient error={error} errorDescription={errorDescription} />;
}
