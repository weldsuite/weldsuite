import { HydrationBoundary } from '@tanstack/react-query';
import { hydratePortalQueries } from '@/lib/server/portal';
import TeamMemberView from './view';

/** Server-rendered: the data is loaded on the server and handed to the client view through the query cache. */
export default async function Page({ params }: { params: Promise<{ workspace: string; employeeId: string }> }) {
  const { workspace, employeeId } = await params;
  const state = await hydratePortalQueries(workspace, [{ path: `/client/team/${employeeId}` }]);
  return (
    <HydrationBoundary state={state}>
      <TeamMemberView />
    </HydrationBoundary>
  );
}
