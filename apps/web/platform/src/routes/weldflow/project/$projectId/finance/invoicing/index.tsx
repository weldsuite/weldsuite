import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/finance/invoicing/page';

export const Route = createFileRoute('/weldflow/project/$projectId/finance/invoicing/')({
  component: PageComponent,
});
