import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldmail/unified/[labelSlug]/layout';
import { parseMailSearch } from '@/app/weldmail/lib/mail-urls';
import { prefetchMailLabelRoute } from '@/app/weldmail/lib/label-route-prefetch';

export const Route = createFileRoute('/weldmail/unified/$labelSlug')({
  validateSearch: parseMailSearch,
  // See the per-account route's twin for why: starts the unified thread list
  // request immediately instead of waiting for the mail layout's access gate
  // (docs/plans/weldmail-mailbox-storage.md phase 1 item 7). No accountId, so
  // labels/stats are skipped — the unified view doesn't fetch them either.
  beforeLoad: ({ context, params }) => {
    prefetchMailLabelRoute(context.queryClient, {
      labelSlug: decodeURIComponent(params.labelSlug),
    });
  },
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
