import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getOutboundMailPage } from '@/app/outbound-mail/fn';
import { OutboundMailPage } from '@/app/outbound-mail/view';

const searchSchema = z.object({
  state: z.coerce.string().optional().catch(undefined),
  status: z.coerce.string().optional().catch(undefined),
  trigger: z.coerce.string().optional().catch(undefined),
  severity: z.coerce.string().optional().catch(undefined),
  case: z.coerce.string().optional().catch(undefined),
});

export const Route = createFileRoute('/_admin/outbound-mail/')({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getOutboundMailPage({ data: deps }),
  component: OutboundMailRoute,
});

function OutboundMailRoute() {
  return <OutboundMailPage {...Route.useLoaderData()} />;
}
