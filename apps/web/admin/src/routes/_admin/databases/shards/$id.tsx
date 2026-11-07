import { createFileRoute } from '@tanstack/react-router';
import { getShardPage } from '@/app/databases/shards/[id]/fn';
import { ShardPage } from '@/app/databases/shards/[id]/view';
import { globalOnlyRoute } from '@/lib/edition';

export const Route = createFileRoute('/_admin/databases/shards/$id')({
  beforeLoad: globalOnlyRoute,
  loader: ({ params }) => getShardPage({ data: { id: params.id } }),
  component: ShardRoute,
});

function ShardRoute() {
  return <ShardPage {...Route.useLoaderData()} />;
}
