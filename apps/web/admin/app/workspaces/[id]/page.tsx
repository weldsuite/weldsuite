import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/auth';
import { getWorkspaceById, listWorkspaceMembers } from '@/lib/workspaces-data';
import {
  getCreditsSummary,
  getWorkspaceBilling,
  listAuditEvents,
  listPlanOptions,
  listWorkspaceInvoices,
  listWorkspacePayments,
} from '@/lib/billing-data';
import { loadStripeSnapshot } from '@/lib/billing-worker';
import { WorkspaceDetail } from './workspace-detail';

export const dynamic = 'force-dynamic';

export default async function WorkspaceDetailPage(props: Readonly<{
  params: Promise<{ id: string }>;
}>) {
  const identity = await requireAdmin();
  const { id } = await props.params;

  const workspace = await getWorkspaceById(id);
  if (!workspace) notFound();

  const [members, billing, plans, credits, invoices, payments, activity, snapshotState] = await Promise.all([
    listWorkspaceMembers(workspace.id),
    getWorkspaceBilling(workspace.id),
    listPlanOptions(),
    getCreditsSummary(workspace.id),
    listWorkspaceInvoices(workspace.id),
    listWorkspacePayments(workspace.id),
    listAuditEvents({ workspaceId: workspace.id, limit: 100 }),
    loadStripeSnapshot(identity, workspace.id),
  ]);
  if (!billing) notFound();

  return (
    <WorkspaceDetail
      workspace={workspace}
      members={members}
      billing={billing}
      plans={plans}
      credits={credits}
      invoices={invoices}
      payments={payments}
      activity={activity}
      snapshotState={snapshotState}
      // Deleted workspaces are history only; viewers never get write controls.
      canWrite={identity.role !== 'viewer' && workspace.deletionState !== 'deleted'}
    />
  );
}
