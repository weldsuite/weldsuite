import { createFileRoute, redirect } from '@tanstack/react-router';

// Entities moved to Settings → Workspace → Entities.
export const Route = createFileRoute('/weldbooks/entities/$id/edit/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/settings/entities/$id/edit', params: { id: params.id }, replace: true });
  },
});
