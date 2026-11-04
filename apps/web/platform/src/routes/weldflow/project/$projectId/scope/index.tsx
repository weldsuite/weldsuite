import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/scope/page';

export const Route = createFileRoute('/weldflow/project/$projectId/scope/')({
  component: PageComponent,
});
