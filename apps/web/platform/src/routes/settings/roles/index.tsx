import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/roles/page';

export const Route = createFileRoute('/settings/roles/')({
  component: PageComponent,
});
