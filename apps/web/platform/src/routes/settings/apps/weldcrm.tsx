import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/apps/weldcrm/page';

export const Route = createFileRoute('/settings/apps/weldcrm')({
  component: PageComponent,
});
