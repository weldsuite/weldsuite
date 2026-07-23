import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/apps/weldsuite/page';

export const Route = createFileRoute('/settings/apps/weldsuite/')({
  component: PageComponent,
});
