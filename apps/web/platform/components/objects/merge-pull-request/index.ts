import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';
import { MERGE_PULL_REQUEST_PANEL_TYPE } from '@/app/weldmerge/pull-requests/pull-request-panel-type';

// Lazy-loaded so the panel body (diff, review, merge) only ships when a pull request is opened.
const PullRequestPanel = lazy(() =>
  import('@/app/weldmerge/pull-requests/pull-request-panel').then((m) => ({ default: m.PullRequestPanel })),
);

registerObjectPanel({
  type: MERGE_PULL_REQUEST_PANEL_TYPE,
  label: 'Pull request',
  component: PullRequestPanel,
});
