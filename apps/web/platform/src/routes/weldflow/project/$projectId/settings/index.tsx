import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/settings/page';

export const Route = createFileRoute('/weldflow/project/$projectId/settings/')({
  component: PageComponent,
});
