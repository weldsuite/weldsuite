import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/governance/stakeholders/page';

export const Route = createFileRoute('/weldflow/project/$projectId/governance/stakeholders/')({
  component: PageComponent,
});
