import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/integrations/attio/page';

export const Route = createFileRoute('/settings/integrations/attio/')({
  component: PageComponent,
});
