import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/timeline/page';

export const Route = createFileRoute('/weldflow/project/$projectId/timeline/')({
  component: PageComponent,
});
