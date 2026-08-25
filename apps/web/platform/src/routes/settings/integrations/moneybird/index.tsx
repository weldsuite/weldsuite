import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/integrations/moneybird/page';

export const Route = createFileRoute('/settings/integrations/moneybird/')({
  component: PageComponent,
});
