import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/finance/costs/page';

export const Route = createFileRoute('/weldflow/project/$projectId/finance/costs/')({
  component: PageComponent,
});
