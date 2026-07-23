import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/goals/page';

export const Route = createFileRoute('/weldflow/project/$projectId/goals/')({
  component: PageComponent,
});
