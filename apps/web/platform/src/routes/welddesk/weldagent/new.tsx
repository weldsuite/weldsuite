import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/welddesk/weldagent/new')({
  beforeLoad: () => {
    throw redirect({ to: '/welddesk/weldagent' });
  },
  component: () => null,
});
