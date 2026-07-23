
import { redirect } from '@/lib/router';
import { WelcomeClient } from './welcome-client';

export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { userId, orgId } = await auth();
  const params = await searchParams;

  // If user is authenticated with an organization, redirect to dashboard
  if (userId && orgId) {
    redirect('/');
  }

  // If authenticated but no organization, redirect to onboarding
  if (userId && !orgId) {
    redirect('/onboarding');
  }

  // Pass any error params
  const error = typeof params.error === 'string' ? params.error : undefined;
  const errorDescription = typeof params.error_description === 'string'
    ? params.error_description
    : undefined;

  return <WelcomeClient error={error} errorDescription={errorDescription} />;
}
