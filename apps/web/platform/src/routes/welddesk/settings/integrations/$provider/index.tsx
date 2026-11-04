import { createFileRoute, redirect } from '@tanstack/react-router';

// Older links (and the Slack OAuth return) point here. The email channel is a
// WeldDesk setting; Slack and Discord are workspace integrations.
export const Route = createFileRoute('/welddesk/settings/integrations/$provider/')({
  beforeLoad: ({ params, search }) => {
    if (params.provider === 'email') {
      throw redirect({ to: '/settings/apps/welddesk/email', search });
    }
    throw redirect({ to: '/settings/integrations/$id', params: { id: params.provider }, search });
  },
});
