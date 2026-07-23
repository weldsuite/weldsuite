import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/export/page';

export const Route = createFileRoute('/settings/export/')({
  component: PageComponent,
});
