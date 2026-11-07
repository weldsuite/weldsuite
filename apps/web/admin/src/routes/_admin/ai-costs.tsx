import { createFileRoute } from '@tanstack/react-router';
import { getAiCostsPage } from '@/app/ai-costs/fn';
import { AiCostsPage } from '@/app/ai-costs/view';

export const Route = createFileRoute('/_admin/ai-costs')({
  loader: () => getAiCostsPage(),
  component: AiCostsRoute,
});

function AiCostsRoute() {
  return <AiCostsPage {...Route.useLoaderData()} />;
}
