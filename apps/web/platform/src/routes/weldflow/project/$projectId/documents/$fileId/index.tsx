import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/documents/[fileId]/page';

export const Route = createFileRoute('/weldflow/project/$projectId/documents/$fileId/')({
  component: PageComponent,
});
