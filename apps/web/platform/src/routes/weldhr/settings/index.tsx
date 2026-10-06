import { createFileRoute, redirect } from '@tanstack/react-router';

// WeldHR configuration lives with the other apps on the workspace settings
// page. This path stays so existing links keep working.
export const Route = createFileRoute('/weldhr/settings/')({
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
  beforeLoad: ({ search }) => {
    throw redirect({
      to: '/settings/apps/weldhr',
      search: search.tab ? { tab: search.tab } : {},
      replace: true,
    });
  },
});
