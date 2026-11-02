import { createFileRoute } from '@tanstack/react-router';
import TicketTypesSettingsPage from '@/app/welddesk/settings/ticket-types/page';

export const Route = createFileRoute('/welddesk/settings/ticket-types/')({
  component: TicketTypesSettingsRoute,
});

function TicketTypesSettingsRoute() {
  return <TicketTypesSettingsPage />;
}
