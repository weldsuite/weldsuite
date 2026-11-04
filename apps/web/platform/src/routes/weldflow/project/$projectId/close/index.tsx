import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/close/page';

export const Route = createFileRoute('/weldflow/project/$projectId/close/')({
  component: PageComponent,
});
