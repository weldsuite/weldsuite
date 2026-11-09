import { createFileRoute } from '@tanstack/react-router';
import { SignInScreen } from '@/lib/auth-client';

/**
 * The sign-in page (`lib/auth-client`). On Global it is Clerk's sign-in, on
 * the console itself; the instance has sign-ups off, so only invited staff get
 * in, and Clerk returns to `redirect_url` afterwards.
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
