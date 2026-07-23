import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/settings/integrations/email/page';

export const Route = createFileRoute('/welddesk/settings/integrations/email/')({
  component: PageComponent,
});
