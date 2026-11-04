import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/governance/page';

export const Route = createFileRoute('/weldflow/project/$projectId/governance/')({
  component: PageComponent,
});
