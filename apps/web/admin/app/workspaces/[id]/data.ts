import '@tanstack/react-start/server-only';

import { requireAdmin } from '@/lib/auth';
import { getWorkspaceById, listWorkspaceMembers } from '@/lib/workspaces-data';
import {
  getCreditsSummary,
  getMollieBillingAccount,
  getWorkspaceBilling,
  listAuditEvents,
  listPlanOptions,
  listWorkspaceInvoices,
  listWorkspacePayments,
} from '@/lib/billing-data';
import { WELDREACH_APP_CODE, type ReachUsage } from '@/lib/app-access';
import { getReachUsage, listWorkspaceAppAccess } from '@/lib/app-access-data';
import { getOutboundSummary } from '@/lib/outbound-mail-data';

/** Everything the workspace page shows; null when there is no such workspace (or its billing row is missing). */
export async function loadWorkspaceDetailPage(input: { id: string }) {
  const identity = await requireAdmin();

  const workspace = await getWorkspaceById(input.id);
  if (!workspace) return null;

  const [members, billing, plans, credits, invoices, payments, activity, mollieBilling, appAccess, outbound] = await Promise.all([
    listWorkspaceMembers(workspace.id),
    getWorkspaceBilling(workspace.id),
    listPlanOptions(),
    getCreditsSummary(workspace.id),
    listWorkspaceInvoices(workspace.id),
    listWorkspacePayments(workspace.id),
    listAuditEvents({ workspaceId: workspace.id, limit: 100 }),
    // Plan billing on Mollie (ADR BILL-014).
    getMollieBillingAccount(workspace.id),
    listWorkspaceAppAccess(workspace.id),
    getOutboundSummary(workspace.id),
  ]);
  if (!billing) return null;

  // Usage only means something once the workspace has been (or is) let in.
  const appUsage: Partial<Record<string, ReachUsage>> = {};
  const reach = appAccess.find((entry) => entry.appCode === WELDREACH_APP_CODE);
  const reachUsage =
    reach?.access && ['approved', 'suspended', 'revoked'].includes(reach.access.status)
      ? await getReachUsage(reach.access.clerkOrgId)
      : null;
  if (reachUsage) appUsage[WELDREACH_APP_CODE] = reachUsage;

  return {
    workspace,
    members,
    billing,
    plans,
    credits,
    invoices,
    payments,
    activity,
    mollieBilling,
    appAccess,
    appUsage,
    outbound,
    // Deleted workspaces are history only; viewers never get write controls.
    canWrite: identity.role !== 'viewer' && workspace.deletionState !== 'deleted',
  };
}

export type WorkspaceDetailPageData = NonNullable<Awaited<ReturnType<typeof loadWorkspaceDetailPage>>>;
