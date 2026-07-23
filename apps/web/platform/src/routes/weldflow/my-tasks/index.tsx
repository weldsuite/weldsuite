import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/weldflow/my-tasks/')({
  beforeLoad: () => {
    throw redirect({ to: '/weldflow' });
  },
});
