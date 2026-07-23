import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/welddesk/weldagent/$id/')({
  beforeLoad: () => {
    throw redirect({ to: '/welddesk/weldagent' });
  },
  component: () => null,
});
