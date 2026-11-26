import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/epics/[epicId]/page';

export const Route = createFileRoute('/weldflow/project/$projectId/epics/$epicId/')({
  component: PageComponent,
});
