import { Suspense } from 'react';
import { HydrationBoundary } from '@tanstack/react-query';
import { PageSkeleton } from '@/components/page-skeleton';
import { streamPortalQueries } from '@/lib/server/portal';
import ClientOverviewView from './view';

/**
 * Server-rendered and streamed: the data request starts here without blocking
 * navigation, and reaches the client view through the query cache.
 */
export default async function Page({ params }: Readonly<{ params: Promise<{ workspace: string }> }>) {
  const { workspace } = await params;
  const state = streamPortalQueries(workspace, [{ path: '/client/overview' }]);
  return (
    <HydrationBoundary state={state}>
      {/* Fresh per page, so the skeleton shows at once on navigation. */}
      <Suspense fallback={<PageSkeleton />}>
        <ClientOverviewView />
      </Suspense>
    </HydrationBoundary>
  );
}
