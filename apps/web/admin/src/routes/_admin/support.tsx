import { createFileRoute } from '@tanstack/react-router';
import { getSupportPage } from '@/app/support/fn';
import { SupportPage } from '@/app/support/view';

export const Route = createFileRoute('/_admin/support')({
  loader: () => getSupportPage(),
  component: SupportRoute,
});

function SupportRoute() {
  return <SupportPage {...Route.useLoaderData()} />;
}
