import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/integrations/crm-sync/page';

export const Route = createFileRoute('/settings/integrations/crm-sync/')({
  component: PageComponent,
});
