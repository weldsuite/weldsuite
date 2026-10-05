import { createFileRoute, redirect } from '@tanstack/react-router';

// Mail accounts are managed on the WeldMail app settings page; this path stays so
// old links (and the onboarding checklist from before the move) keep working.
export const Route = createFileRoute('/weldmail/settings/accounts/')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/apps/weldmail', replace: true });
  },
});
