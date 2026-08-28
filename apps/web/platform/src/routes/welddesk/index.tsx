import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/welddesk/')({
  beforeLoad: () => {
    throw redirect({ to: '/welddesk/inbox' });
  },
});
