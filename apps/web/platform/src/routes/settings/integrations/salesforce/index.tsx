import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/integrations/salesforce/page';

export const Route = createFileRoute('/settings/integrations/salesforce/')({
  component: PageComponent,
});
