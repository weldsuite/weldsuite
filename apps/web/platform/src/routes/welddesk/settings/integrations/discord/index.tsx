import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/settings/integrations/discord/page';

export const Route = createFileRoute('/welddesk/settings/integrations/discord/')({
  component: PageComponent,
});
