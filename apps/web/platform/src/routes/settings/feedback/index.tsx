import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/feedback/page';

export const Route = createFileRoute('/settings/feedback/')({
  component: PageComponent,
});
