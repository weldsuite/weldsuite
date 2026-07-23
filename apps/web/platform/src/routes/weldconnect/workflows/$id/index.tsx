import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/weldconnect/workflows/$id/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/weldconnect/workflows/$id/edit', params });
  },
});
