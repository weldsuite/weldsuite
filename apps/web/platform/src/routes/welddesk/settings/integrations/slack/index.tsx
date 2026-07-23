import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/settings/integrations/slack/page';

export const Route = createFileRoute('/welddesk/settings/integrations/slack/')({
  component: PageComponent,
});
