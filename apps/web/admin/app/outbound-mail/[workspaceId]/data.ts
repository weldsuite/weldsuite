import 'server-only';

import { requireAdmin } from '@/lib/auth';
import { isMailApiConfigured, loadOutboundInspect } from '@/lib/mail-api';
import { getOutboundWorkspace, listWorkspaceCases, listWorkspaceEvents } from '@/lib/outbound-mail-data';

/** A workspace's outbound mail policy, live ledger, cases and trail; null when there is no such workspace. */
export async function loadOutboundWorkspacePage(input: { workspaceId: string }) {
  const identity = await requireAdmin();

  const found = await getOutboundWorkspace(input.workspaceId);
  if (!found) return null;
  const { workspace, policy } = found;

  const [live, cases, events] = await Promise.all([
    loadOutboundInspect(identity, workspace.id),
    listWorkspaceCases(workspace.id),
    listWorkspaceEvents(workspace.id),
  ]);

  // Policy changes need a live workspace; case reviews stay open for a deleted one (they are labelled data).
  const canReview = identity.role !== 'viewer';
  const canWrite = canReview && !workspace.deleted;

  return {
    workspace,
    policy,
    live,
    cases,
    events,
    canReview,
    canWrite,
    mailApiConfigured: isMailApiConfigured(),
  };
}

export type OutboundWorkspacePageData = NonNullable<Awaited<ReturnType<typeof loadOutboundWorkspacePage>>>;
