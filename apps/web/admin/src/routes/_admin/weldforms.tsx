import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getWeldFormsPage } from '@/app/weldforms/fn';
import { WeldFormsPage } from '@/app/weldforms/view';

const searchSchema = z.object({
  status: z.coerce.string().optional().catch(undefined),
});

export const Route = createFileRoute('/_admin/weldforms')({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getWeldFormsPage({ data: deps }),
  component: WeldFormsRoute,
});

function WeldFormsRoute() {
  return <WeldFormsPage {...Route.useLoaderData()} />;
}
