import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/files/page';

export const Route = createFileRoute('/weldflow/project/$projectId/files/')({
  component: PageComponent,
});
