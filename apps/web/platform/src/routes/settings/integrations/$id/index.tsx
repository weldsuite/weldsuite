import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/integrations/[id]/page';

export const Route = createFileRoute('/settings/integrations/$id/')({
  component: PageComponent,
});
