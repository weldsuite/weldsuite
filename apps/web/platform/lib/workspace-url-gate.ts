/**
 * What the app shell does with the workspace a URL names (FE-013).
 *
 * Pure, so every case is a table row in the tests; the hook that acts on it is
 * `useWorkspaceUrlGate` in components/workspace-url-gate.tsx.
 */

import { findWorkspace, type WorkspaceRef } from '@/lib/workspace-url';

export interface WorkspaceUrlGateInput {
  /** The ref the address bar names, or null for a bare path. */
  urlRef: string | null;
  /** The tab's active Clerk organization. */
  orgId: string | null | undefined;
  orgSlug: string | null | undefined;
  /** A workspace just created or joined that should become active (lib/pending-organization). */
  pendingOrgId: string | null;
  /** Every membership, or null while they are still loading. */
  memberships: readonly WorkspaceRef[] | null;
}

export type WorkspaceUrlDecision =
  /** The tab is in the URL's workspace (or the path is bare): render, and links carry `ref`. */
  | { kind: 'ready'; ref: string }
  /** Nothing for the URL to settle yet: a bare path and no active org. The shell's own activation runs. */
  | { kind: 'skip' }
  /** Hold rendering until the memberships are in. */
  | { kind: 'wait' }
  /** The URL names another of the user's workspaces: make it the tab's. */
  | { kind: 'activate'; orgId: string }
  /** The URL names a workspace the user is not a member of. */
  | { kind: 'not-found' };

const refOf = (slug: string | null | undefined, id: string) => slug || id;

export function decideWorkspaceUrl(input: WorkspaceUrlGateInput): WorkspaceUrlDecision {
  const { urlRef, orgId, orgSlug, pendingOrgId, memberships } = input;

  if (!urlRef) return orgId ? { kind: 'ready', ref: refOf(orgSlug, orgId) } : { kind: 'skip' };

  // The common case, settled without a network call.
  if (orgId && (urlRef === orgId || (!!orgSlug && urlRef.toLowerCase() === orgSlug.toLowerCase()))) {
    return { kind: 'ready', ref: refOf(orgSlug, orgId) };
  }

  // A workspace just created or joined is often not in Clerk's membership
  // list yet; its own link is enough to activate it.
  if (pendingOrgId && urlRef === pendingOrgId) {
    return pendingOrgId === orgId ? { kind: 'ready', ref: refOf(orgSlug, orgId) } : { kind: 'activate', orgId: pendingOrgId };
  }

  if (!memberships) return { kind: 'wait' };
  const workspace = findWorkspace(urlRef, memberships);
  if (!workspace) return { kind: 'not-found' };
  // Already active, but the session's slug claim is stale (just renamed).
  if (workspace.id === orgId) return { kind: 'ready', ref: refOf(workspace.slug, workspace.id) };
  return { kind: 'activate', orgId: workspace.id };
}
