import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/activity/page';

export const Route = createFileRoute('/settings/activity/')({
  component: PageComponent,
});
