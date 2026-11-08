import { createFileRoute } from '@tanstack/react-router';
import { getAiCostsPage } from '@/app/ai-costs/fn';
import { AiCostsPage } from '@/app/ai-costs/view';
import { globalOnlyRoute } from '@/lib/edition';

export const Route = createFileRoute('/_admin/ai-costs')({
  beforeLoad: globalOnlyRoute,
  loader: () => getAiCostsPage(),
  component: AiCostsRoute,
});

function AiCostsRoute() {
  return <AiCostsPage {...Route.useLoaderData()} />;
}
