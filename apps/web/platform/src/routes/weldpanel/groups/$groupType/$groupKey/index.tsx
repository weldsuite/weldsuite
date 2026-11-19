import { createFileRoute, redirect } from '@tanstack/react-router';
import { panelGroupHref } from '@/components/objects/panel-group/panel-group-tabs';

// A group opens in the shared object panel on the Groups list; the old profile
// URL (and every link to it) lands there with the panel expanded to fullscreen.
export const Route = createFileRoute('/weldpanel/groups/$groupType/$groupKey/')({
  validateSearch: (search: Record<string, unknown>): { project?: string; tab?: string } => ({
    project: typeof search.project === 'string' ? search.project : undefined,
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
  beforeLoad: ({ params, search }) => {
    throw redirect({ href: panelGroupHref(search.project ?? '', params.groupType, params.groupKey, search.tab), replace: true });
  },
});
