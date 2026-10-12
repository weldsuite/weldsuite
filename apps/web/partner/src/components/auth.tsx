import { SignIn } from '@clerk/clerk-react';
import { useLocation } from 'react-router-dom';

/**
 * Sign-in for the partner portal. Partner users are ordinary WeldSuite users
 * (same Clerk instance as the platform); being a partner member is decided by
 * `GET /api/partner/me`, not by Clerk. There is no sign-up page: partner
 * members are invited by email.
 */
export function SignInPage() {
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  const redirectUrl = from?.startsWith('/') && !from.startsWith('//') ? from : '/';

  return (
    <div className="mx-auto flex min-h-screen max-w-md items-center justify-center px-4">
      <SignIn routing="path" path="/sign-in" forceRedirectUrl={redirectUrl} />
    </div>
  );
}
