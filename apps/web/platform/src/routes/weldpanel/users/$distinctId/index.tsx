import { createFileRoute, redirect } from '@tanstack/react-router';
import { panelPersonHref } from '@/components/objects/panel-person/panel-person-tabs';

// A person opens in the shared object panel on the Users list; the old profile
// URL (and every link to it) lands there with the panel expanded to fullscreen.
export const Route = createFileRoute('/weldpanel/users/$distinctId/')({
  validateSearch: (search: Record<string, unknown>): { project?: string; tab?: string } => ({
    project: typeof search.project === 'string' ? search.project : undefined,
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
  beforeLoad: ({ params, search }) => {
    throw redirect({ href: panelPersonHref(search.project ?? '', params.distinctId, search.tab), replace: true });
  },
});
