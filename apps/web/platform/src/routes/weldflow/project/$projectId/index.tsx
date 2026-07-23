import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/weldflow/project/$projectId/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/weldflow/project/$projectId/tasks', params });
  },
});
