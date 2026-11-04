import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/raid/dependencies/page';

export const Route = createFileRoute('/weldflow/project/$projectId/raid/dependencies/')({
  component: PageComponent,
});
