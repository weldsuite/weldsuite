import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/welddesk/automations/')({
  beforeLoad: () => {
    throw redirect({ to: '/welddesk/workflows' });
  },
});
