import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/members/[memberId]/page';

export const Route = createFileRoute('/weldflow/project/$projectId/members/$memberId/')({
  component: PageComponent,
});
