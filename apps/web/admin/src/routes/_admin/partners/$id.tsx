import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getPartnerDetailPage } from '@/app/partners/[id]/fn';
import { PartnerDetailPage } from '@/app/partners/[id]/view';
import { globalOnlyRoute } from '@/lib/edition';

const searchSchema = z.object({
  tab: z.coerce.string().optional().catch(undefined),
});

export const Route = createFileRoute('/_admin/partners/$id')({
  beforeLoad: globalOnlyRoute,
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ params, deps }) => getPartnerDetailPage({ data: { id: params.id, ...deps } }),
  component: PartnerDetailRoute,
});

function PartnerDetailRoute() {
  return <PartnerDetailPage {...Route.useLoaderData()} />;
}
