import { createFileRoute, redirect } from '@tanstack/react-router';

// Moved to Settings → Apps → WeldDesk; old links and bookmarks land there.
export const Route = createFileRoute('/welddesk/help-center/')({
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/settings/apps/welddesk/help-center', search });
  },
});
