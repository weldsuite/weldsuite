import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/governance/decisions/page';

export const Route = createFileRoute('/weldflow/project/$projectId/governance/decisions/')({
  component: PageComponent,
});
