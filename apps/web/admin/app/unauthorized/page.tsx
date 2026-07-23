import { ShieldAlert } from 'lucide-react';
import { SignOutButton } from '@clerk/nextjs';
import { getAdminIdentity } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function UnauthorizedPage() {
  // If a real admin lands here (e.g. a superadmin-only page), send them home.
  const identity = await getAdminIdentity();

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md w-full rounded-xl border bg-card p-8 text-center space-y-4">
        <div className="mx-auto h-12 w-12 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
          <ShieldAlert className="h-6 w-6 text-amber-600" />
        </div>
        <div>
          <h1 className="text-lg font-semibold">Access restricted</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {identity
              ? 'This area is limited to superadmins. Ask a superadmin if you need access.'
              : 'Your account doesn’t have admin access. If you believe this is a mistake, ask a WeldSuite superadmin to invite you in Clerk.'}
          </p>
        </div>
        <div className="flex items-center justify-center gap-2 pt-2">
          {identity ? (
            <a
              href="/"
              className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium"
            >
              Back to dashboard
            </a>
          ) : (
            <SignOutButton>
              <button className="px-4 py-2 rounded-md border text-sm font-medium hover:bg-accent">
                Sign out
              </button>
            </SignOutButton>
          )}
        </div>
      </div>
    </div>
  );
}
