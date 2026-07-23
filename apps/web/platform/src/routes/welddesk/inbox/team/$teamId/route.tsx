import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/welddesk/inbox/team/layout';

export const Route = createFileRoute('/welddesk/inbox/team/$teamId')({
  component: () => {
    const { teamId } = Route.useParams();
    return (
      <LayoutComponent teamId={teamId}>
        <Outlet />
      </LayoutComponent>
    );
  },
});
