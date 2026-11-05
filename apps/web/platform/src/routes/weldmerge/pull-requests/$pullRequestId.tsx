import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmerge/pull-requests/[pullRequestId]/page';
import '@/lib/breadcrumbs/types';

// The id is not a name a person recognises, so the crumb is left out and the
// back button of the page leads to the list.
export const Route = createFileRoute('/weldmerge/pull-requests/$pullRequestId')({
  staticData: { breadcrumb: { hidden: true } },
  component: PageComponent,
});
