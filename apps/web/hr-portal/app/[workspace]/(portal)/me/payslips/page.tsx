import { Suspense } from 'react';
import { HydrationBoundary } from '@tanstack/react-query';
import { PageSkeleton } from '@/components/page-skeleton';
import { streamPortalQueries } from '@/lib/server/portal';
import PayslipsView from './view';

/**
 * Server-rendered and streamed: the data requests start here without blocking
 * navigation, and reach the client view through the query cache.
 */
export default async function Page({ params }: Readonly<{ params: Promise<{ workspace: string }> }>) {
  const { workspace } = await params;
  const state = streamPortalQueries(workspace, [
    { path: '/employee/payslips' },
    { path: '/employee/annual-statements' },
  ]);
  return (
    <HydrationBoundary state={state}>
      {/* Fresh per page, so the skeleton shows at once on navigation. */}
      <Suspense fallback={<PageSkeleton />}>
        <PayslipsView />
      </Suspense>
    </HydrationBoundary>
  );
}
