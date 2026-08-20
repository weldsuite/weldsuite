import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/integrations/sendcloud/page';

export const Route = createFileRoute('/settings/integrations/sendcloud/')({
  component: PageComponent,
});
