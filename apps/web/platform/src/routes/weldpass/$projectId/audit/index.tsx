import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpass/[projectId]/audit/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldpass/$projectId/audit/')({
  staticData: { breadcrumb: { label: 'Audit log' } },
  component: PageComponent,
});
