import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/apps/weldflow/page';

export const Route = createFileRoute('/settings/apps/weldflow')({
  component: PageComponent,
});
