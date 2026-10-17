import { createFileRoute, redirect } from '@tanstack/react-router';

// The project timeline is the Gantt view.
export const Route = createFileRoute('/weldflow/project/$projectId/timeline/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/weldflow/project/$projectId/gantt', params });
  },
});
