import { createFileRoute } from '@tanstack/react-router';
import { getOutboundWorkspacePage } from '@/app/outbound-mail/[workspaceId]/fn';
import { OutboundWorkspacePage } from '@/app/outbound-mail/[workspaceId]/view';

export const Route = createFileRoute('/_admin/outbound-mail/$workspaceId')({
  loader: ({ params }) => getOutboundWorkspacePage({ data: { workspaceId: params.workspaceId } }),
  component: OutboundWorkspaceRoute,
});

function OutboundWorkspaceRoute() {
  return <OutboundWorkspacePage {...Route.useLoaderData()} />;
}
