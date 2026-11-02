import { createFileRoute, redirect } from '@tanstack/react-router';

// Moved to Settings → Apps → WeldDesk; old links and bookmarks land there.
export const Route = createFileRoute('/welddesk/chat-widget/$widgetId/')({
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: '/settings/apps/welddesk/chat-widget/$widgetId', params, search });
  },
});
