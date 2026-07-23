import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/list/page';

export const Route = createFileRoute('/weldflow/project/$projectId/list/')({
  component: PageComponent,
});
