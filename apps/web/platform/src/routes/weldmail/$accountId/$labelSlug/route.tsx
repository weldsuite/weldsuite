import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldmail/[accountId]/[labelSlug]/layout';
import { parseMailSearch } from '@/app/weldmail/lib/mail-urls';
import { prefetchMailLabelRoute } from '@/app/weldmail/lib/label-route-prefetch';

export const Route = createFileRoute('/weldmail/$accountId/$labelSlug')({
  validateSearch: parseMailSearch,
  // Fire the thread list / labels / stats requests as soon as the route
  // matches, in parallel with the mail layout's `useAppAccess` gate, instead
  // of only once it passes (docs/plans/weldmail-mailbox-storage.md phase 1
  // item 7). Not awaited — see label-route-prefetch.ts.
  beforeLoad: ({ context, params }) => {
    prefetchMailLabelRoute(context.queryClient, {
      accountId: params.accountId,
      labelSlug: decodeURIComponent(params.labelSlug),
    });
  },
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
});
