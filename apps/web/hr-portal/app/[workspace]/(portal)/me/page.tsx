import { HydrationBoundary } from '@tanstack/react-query';
import { hydratePortalQueries } from '@/lib/server/portal';
import EmployeeHomeView from './view';

/** Server-rendered: the data is loaded on the server and handed to the client view through the query cache. */
export default async function Page({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params;
  const state = await hydratePortalQueries(workspace, [{ path: '/employee/overview' }]);
  return (
    <HydrationBoundary state={state}>
      <EmployeeHomeView />
    </HydrationBoundary>
  );
}
