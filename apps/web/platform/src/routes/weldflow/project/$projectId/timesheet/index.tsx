import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/timesheet/page';

export const Route = createFileRoute('/weldflow/project/$projectId/timesheet/')({
  component: PageComponent,
});
