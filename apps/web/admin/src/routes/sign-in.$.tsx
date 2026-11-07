import { createFileRoute } from '@tanstack/react-router';
import { SignIn } from '@clerk/tanstack-react-start';

/**
 * Clerk's sign-in, on the console itself (Next sent people to Clerk's hosted
 * page). The instance has sign-ups off, so only invited staff get in. Clerk
 * returns to `redirect_url` afterwards.
 */
export const Route = createFileRoute('/sign-in/$')({
  component: SignInPage,
});

function SignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <SignIn routing="path" path="/sign-in" fallbackRedirectUrl="/" />
    </div>
  );
}
