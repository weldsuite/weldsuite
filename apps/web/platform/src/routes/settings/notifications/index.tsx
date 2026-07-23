import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/notifications/page';

export const Route = createFileRoute('/settings/notifications/')({
  component: PageComponent,
});
