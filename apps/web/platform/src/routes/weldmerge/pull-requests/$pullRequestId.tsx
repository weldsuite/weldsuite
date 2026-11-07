import { createFileRoute, redirect } from '@tanstack/react-router';
import { MERGE_PULL_REQUEST_PANEL_TYPE } from '@/app/weldmerge/pull-requests/pull-request-panel-type';

// A pull request opens in the shared object panel on the pull request list;
// the old detail URL (inbox, chat cards, issues, releases) lands there with
// the panel expanded to fullscreen.
export const Route = createFileRoute('/weldmerge/pull-requests/$pullRequestId')({
  beforeLoad: ({ params }) => {
    throw redirect({
      href: `/weldmerge/pull-requests?stack=${MERGE_PULL_REQUEST_PANEL_TYPE}:${encodeURIComponent(params.pullRequestId)}:fullscreen`,
      replace: true,
    });
  },
});
