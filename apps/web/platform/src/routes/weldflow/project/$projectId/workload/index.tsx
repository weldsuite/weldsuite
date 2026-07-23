import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/workload/page';

export const Route = createFileRoute('/weldflow/project/$projectId/workload/')({
  component: PageComponent,
});
