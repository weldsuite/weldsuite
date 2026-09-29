import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/preview/weldflow/project/$projectId/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/preview/weldflow/project/$projectId/tasks', params });
  },
});
