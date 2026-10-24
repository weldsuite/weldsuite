import { createFileRoute } from '@tanstack/react-router';
import DeskAssignmentSettingsPage from '@/app/welddesk/settings/assignment/page';

export const Route = createFileRoute('/welddesk/settings/assignment/')({
  component: DeskAssignmentSettingsRoute,
});

function DeskAssignmentSettingsRoute() {
  return <DeskAssignmentSettingsPage />;
}
