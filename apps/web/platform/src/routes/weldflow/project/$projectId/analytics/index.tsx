import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/analytics/page';

export const Route = createFileRoute('/weldflow/project/$projectId/analytics/')({
  component: PageComponent,
});
