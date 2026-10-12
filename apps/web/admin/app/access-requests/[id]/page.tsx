import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Building2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { AppAccessCard } from '@/components/app-access/app-access-card';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import { requireAdmin } from '@/lib/auth';
import { WELDREACH_APP_CODE } from '@/lib/app-access';
import { getAppAccessById, getReachUsage } from '@/lib/app-access-data';
import { getWorkspaceById } from '@/lib/workspaces-data';

export const dynamic = 'force-dynamic';

export default async function AccessRequestPage(props: Readonly<{
  params: Promise<{ id: string }>;
}>) {
  const identity = await requireAdmin();
  const { id } = await props.params;

  const access = await getAppAccessById(id);
  if (!access) notFound();

  const workspace = await getWorkspaceById(access.workspaceId);
  const usage =
    access.appCode === WELDREACH_APP_CODE && ['approved', 'suspended', 'revoked'].includes(access.status)
      ? await getReachUsage(access.clerkOrgId)
      : undefined;

  return (
    <PageContent>
      <PageBody width="narrow" className="space-y-6">
        <div>
          <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2 text-muted-foreground">
            <Link href="/access-requests">
              <ArrowLeft className="h-4 w-4" />
              All access requests
            </Link>
          </Button>

          <PageHeading
            title={access.request?.companyName ?? access.workspaceName}
            description={
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-sm">{access.appName}</span>
                <span aria-hidden>·</span>
                <Link
                  href={`/workspaces/${access.workspaceId}`}
                  className="inline-flex items-center gap-1 text-sm underline-offset-2 hover:underline"
                >
                  <Building2 className="h-3.5 w-3.5" />
                  {access.workspaceName}
                </Link>
                <span className="font-mono text-xs">{access.workspaceSlug}</span>
              </span>
            }
          />
        </div>

        <AppAccessCard
          workspaceId={access.workspaceId}
          appCode={access.appCode}
          appName={access.appName}
          access={access}
          usage={usage}
          // Deleted workspaces are history only; viewers never get write controls.
          canWrite={identity.role !== 'viewer' && workspace?.deletionState !== 'deleted'}
        />
      </PageBody>
    </PageContent>
  );
}
