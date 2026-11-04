import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/finance/forecast/page';

export const Route = createFileRoute('/weldflow/project/$projectId/finance/forecast/')({
  component: PageComponent,
});
