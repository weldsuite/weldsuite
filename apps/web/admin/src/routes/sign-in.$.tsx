import { createFileRoute } from '@tanstack/react-router';
import { SignInScreen } from '@/lib/auth-client';

/**
 * Where staff land after signing out or a failed sign-in (`lib/auth-client`),
 * with a button that goes back to the identity provider.
 */
export const Route = createFileRoute('/sign-in/$')({
  component: SignInPage,
});

function SignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <SignInScreen />
    </div>
  );
}
