import '@tanstack/react-start/server-only';

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
import { loadSsoView, loadStripeSnapshot } from '@/lib/billing-worker';
import { WELDREACH_APP_CODE, type ReachUsage } from '@/lib/app-access';
import { getReachUsage, listWorkspaceAppAccess } from '@/lib/app-access-data';
import { getOutboundSummary } from '@/lib/outbound-mail-data';
import { getWorkspaceDatabase } from '@/lib/databases-data';
import { loadWorkspaceDatabaseTab } from '@/lib/database-moves-data';

/** Everything the workspace page shows; null when there is no such workspace (or its billing or database row is missing). */
export async function loadWorkspaceDetailPage(input: { id: string }) {
  const identity = await requireAdmin();

  const workspace = await getWorkspaceById(input.id);
  if (!workspace) return null;

  const [members, billing, plans, credits, invoices, payments, activity, snapshotState, ssoState, appAccess, outbound, database] = await Promise.all([
    listWorkspaceMembers(workspace.id),
    getWorkspaceBilling(workspace.id),
    listPlanOptions(),
    getCreditsSummary(workspace.id),
    listWorkspaceInvoices(workspace.id),
    listWorkspacePayments(workspace.id),
    listAuditEvents({ workspaceId: workspace.id, limit: 100 }),
    loadStripeSnapshot(identity, workspace.id),
    loadSsoView(identity, workspace.id),
    listWorkspaceAppAccess(workspace.id),
    getOutboundSummary(workspace.id),
    getWorkspaceDatabase(workspace.id),
  ]);
  if (!billing || !database) return null;

  // Usage only means something once the workspace has been (or is) let in.
  const appUsage: Partial<Record<string, ReachUsage>> = {};
  const reach = appAccess.find((entry) => entry.appCode === WELDREACH_APP_CODE);
  const [reachUsage, databaseTab] = await Promise.all([
    reach?.access && ['approved', 'suspended', 'revoked'].includes(reach.access.status)
      ? getReachUsage(reach.access.clerkOrgId)
      : null,
    // Moves and live compute come from the workspace worker; the tab degrades without it.
    loadWorkspaceDatabaseTab(identity, workspace.id, database),
  ]);
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
    snapshotState,
    ssoState,
    appAccess,
    appUsage,
    outbound,
    database,
    databaseTab,
    // Deleted workspaces are history only; viewers never get write controls.
    canWrite: identity.role !== 'viewer' && workspace.deletionState !== 'deleted',
    canMoveDatabase: identity.isSuperAdmin && workspace.deletionState !== 'deleted',
  };
}

export type WorkspaceDetailPageData = NonNullable<Awaited<ReturnType<typeof loadWorkspaceDetailPage>>>;
