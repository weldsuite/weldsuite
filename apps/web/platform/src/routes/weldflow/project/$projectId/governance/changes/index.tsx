import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/governance/changes/page';

export const Route = createFileRoute('/weldflow/project/$projectId/governance/changes/')({
  component: PageComponent,
});
