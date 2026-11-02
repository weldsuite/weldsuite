import { createFileRoute, redirect } from '@tanstack/react-router';

// Saved replies moved out of settings, next to the articles under Knowledge.
export const Route = createFileRoute('/welddesk/settings/saved-replies/')({
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/welddesk/saved-replies', search });
  },
});
