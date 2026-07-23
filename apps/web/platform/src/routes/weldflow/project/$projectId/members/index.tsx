import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/members/page';

export const Route = createFileRoute('/weldflow/project/$projectId/members/')({
  component: PageComponent,
});
