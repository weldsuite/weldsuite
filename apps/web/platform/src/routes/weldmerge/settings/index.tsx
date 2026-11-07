import { createFileRoute, redirect } from '@tanstack/react-router';
import { validateWeldMergeSettingsSearch } from '@/app/weldmerge/lib/settings-path';

// WeldMerge configuration lives with the other apps on the workspace settings
// page. This path stays so existing links, and the GitHub install and OAuth
// round trips merge-api still sends here, keep working.
export const Route = createFileRoute('/weldmerge/settings/')({
  validateSearch: validateWeldMergeSettingsSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/settings/apps/weldmerge', search, replace: true });
  },
});
