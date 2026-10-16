import { createFileRoute, redirect } from '@tanstack/react-router';

// WeldFlow has no settings of its own: the task digest and notification
// preferences live in the platform settings.
export const Route = createFileRoute('/weldflow/settings/')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/notifications' });
  },
});
