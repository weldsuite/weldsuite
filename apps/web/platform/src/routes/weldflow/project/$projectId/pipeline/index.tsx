import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/pipeline/page';

export const Route = createFileRoute('/weldflow/project/$projectId/pipeline/')({
  component: PageComponent,
});
