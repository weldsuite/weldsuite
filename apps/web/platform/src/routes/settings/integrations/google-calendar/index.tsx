import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/integrations/google-calendar/page';

export const Route = createFileRoute('/settings/integrations/google-calendar/')({
  component: PageComponent,
});
