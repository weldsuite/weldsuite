import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/table/[fileId]/page';

export const Route = createFileRoute('/weldflow/project/$projectId/table/$fileId/')({
  component: PageComponent,
});
