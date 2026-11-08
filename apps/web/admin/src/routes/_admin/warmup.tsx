import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getWarmupNetworkPage } from '@/app/warmup/fn';
import { WarmupNetworkPage } from '@/app/warmup/view';

const searchSchema = z.object({
  q: z.coerce.string().optional().catch(undefined),
});

export const Route = createFileRoute('/_admin/warmup')({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getWarmupNetworkPage({ data: deps }),
  component: WarmupNetworkRoute,
});

function WarmupNetworkRoute() {
  return <WarmupNetworkPage {...Route.useLoaderData()} />;
}
