import { createFileRoute } from '@tanstack/react-router';
import { getFlagsPage } from '@/app/flags/fn';
import { FlagsPage } from '@/app/flags/view';
import { kubernetesOnlyRoute } from '@/lib/edition';

export const Route = createFileRoute('/_admin/flags')({
  beforeLoad: kubernetesOnlyRoute,
  loader: () => getFlagsPage(),
  component: FlagsRoute,
});

function FlagsRoute() {
  return <FlagsPage {...Route.useLoaderData()} />;
}
