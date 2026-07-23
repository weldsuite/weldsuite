import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/integrations/page';

export const Route = createFileRoute('/settings/integrations/')({
  component: PageComponent,
});
