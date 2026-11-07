import { createFileRoute } from '@tanstack/react-router';
import { getSupportPage } from '@/app/support/fn';
import { SupportPage } from '@/app/support/view';
import { globalOnlyRoute } from '@/lib/edition';

export const Route = createFileRoute('/_admin/support')({
  beforeLoad: globalOnlyRoute,
  loader: () => getSupportPage(),
  component: SupportRoute,
});

function SupportRoute() {
  return <SupportPage {...Route.useLoaderData()} />;
}
