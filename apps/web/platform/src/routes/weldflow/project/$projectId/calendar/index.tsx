import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/calendar/page';

export const Route = createFileRoute('/weldflow/project/$projectId/calendar/')({
  component: PageComponent,
});
