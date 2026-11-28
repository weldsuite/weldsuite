import { createFileRoute } from '@tanstack/react-router';
import { getFlagsPage } from '@/app/flags/fn';
import { FlagsPage } from '@/app/flags/view';

export const Route = createFileRoute('/_admin/flags')({
  loader: () => getFlagsPage(),
  component: FlagsRoute,
});

function FlagsRoute() {
  return <FlagsPage {...Route.useLoaderData()} />;
}
