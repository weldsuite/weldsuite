import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/table/page';

export const Route = createFileRoute('/weldflow/project/$projectId/table/')({
  component: PageComponent,
});
