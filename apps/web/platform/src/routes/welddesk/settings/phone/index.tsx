import { createFileRoute, redirect } from '@tanstack/react-router';

// Moved to Settings → Apps → WeldDesk; old links and bookmarks land there.
export const Route = createFileRoute('/welddesk/settings/phone/')({
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/settings/apps/welddesk/phone', search });
  },
});
