import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/raid/assumptions/page';

export const Route = createFileRoute('/weldflow/project/$projectId/raid/assumptions/')({
  component: PageComponent,
});
