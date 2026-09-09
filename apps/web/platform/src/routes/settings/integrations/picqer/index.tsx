import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/integrations/picqer/page';

export const Route = createFileRoute('/settings/integrations/picqer/')({
  component: PageComponent,
});
