import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/integrations/slack/page';

export const Route = createFileRoute('/settings/integrations/slack/')({
  component: PageComponent,
});
