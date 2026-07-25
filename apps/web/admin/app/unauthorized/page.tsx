import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';
import { SignOutButton } from '@clerk/nextjs';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { getAdminIdentity } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function UnauthorizedPage() {
  // If a real admin lands here (e.g. a superadmin-only page), send them home.
  const identity = await getAdminIdentity();

  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="w-full max-w-md py-8">
        <CardContent className="space-y-4 px-8 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10">
            <ShieldAlert className="h-6 w-6 text-amber-600 dark:text-amber-400" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Access restricted</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {identity
                ? 'This area is limited to superadmins. Ask a superadmin if you need access.'
                : 'Your account doesn’t have admin access. If you believe this is a mistake, ask a WeldSuite superadmin to invite you in Clerk.'}
            </p>
          </div>
          <div className="flex items-center justify-center gap-2 pt-2">
            {identity ? (
              <Button asChild>
                <Link href="/">Back to dashboard</Link>
              </Button>
            ) : (
              <SignOutButton>
                <Button variant="outline">Sign out</Button>
              </SignOutButton>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
