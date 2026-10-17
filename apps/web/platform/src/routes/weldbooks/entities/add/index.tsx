import { createFileRoute, redirect } from '@tanstack/react-router';

// Entities moved to Settings → Workspace → Entities.
export const Route = createFileRoute('/weldbooks/entities/add/')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/entities/add', replace: true });
  },
});
