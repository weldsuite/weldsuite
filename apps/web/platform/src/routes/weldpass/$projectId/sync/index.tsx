import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpass/[projectId]/sync/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldpass/$projectId/sync/')({
  staticData: { breadcrumb: { label: 'Sync' } },
  component: PageComponent,
});
