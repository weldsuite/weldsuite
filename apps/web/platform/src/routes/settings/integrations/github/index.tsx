import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/integrations/github/page';

export const Route = createFileRoute('/settings/integrations/github/')({
  component: PageComponent,
});
