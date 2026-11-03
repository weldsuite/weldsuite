import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/scope/value/page';

export const Route = createFileRoute('/weldflow/project/$projectId/scope/value/')({
  component: PageComponent,
});
