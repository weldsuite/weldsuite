import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmerge/issues/[issueKey]/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldmerge/issues/$issueKey')({
  // The key (PLAT-209) is the name of the issue.
  loader: ({ params }) => ({ breadcrumbLabel: params.issueKey }),
  component: PageComponent,
});
