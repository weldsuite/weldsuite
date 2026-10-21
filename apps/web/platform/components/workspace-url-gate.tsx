import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { useAuth, useOrganizationList } from '@clerk/clerk-react';
import {
  clearPendingOrganizationIf,
  peekPendingOrganization,
  setPendingOrganization,
} from '@/lib/pending-organization';
import { isWorkspaceScopedPath, parseWorkspacePath, workspacePath } from '@/lib/workspace-url';
import { decideWorkspaceUrl } from '@/lib/workspace-url-gate';
import {
  setActiveWorkspaceRef,
  useWorkspaceUrlState,
  workspaceUrlsEnabled,
} from '@/lib/workspace-url-rewrite';
import type { WorkspaceLinkMembership } from '@/components/workspace/workspace-link-problem';

/**
 * - `off`: nothing for the URL to settle (kill switch, a page outside a
 *   workspace, a bare path with no active org); the shell carries on as before.
 * - `blocked`: render nothing yet, the tab may be in the wrong workspace.
 * - `ready`: the tab is in the URL's workspace and links carry it.
 */
export type WorkspaceUrlGateStatus = 'off' | 'blocked' | 'ready' | 'not-found' | 'error';

export interface WorkspaceUrlGate {
  status: WorkspaceUrlGateStatus;
  /** Whether the URL names a workspace, so the shell's own org activation stands aside. */
  ownsActivation: boolean;
  memberships: readonly WorkspaceLinkMembership[];
  /** The in-app path and query the URL points at, for the not-found screen. */
  target: string;
}

/**
 * The URL wins (FE-013): make the tab's workspace the one its `/w/{ref}` URL
 * names, and keep the address bar naming it.
 *
 * Clerk keeps the active organization per tab, so switching here leaves the
 * user's other tabs alone. A switch away from an org this page already loaded
 * reloads, like the workspace switcher, so nothing hydrates against the old
 * workspace. Children must not render until `ready`: their queries would run
 * with the previous workspace's token.
 *
 * Once settled, an org change that leaves the URL alone is the app's own
 * switch (the switcher, a workspace just created or deleted): the gate follows
 * it rather than switching back, and stays `ready`.
 */
export function useWorkspaceUrlGate(pathname: string): WorkspaceUrlGate {
  const router = useRouter();
  const target = useRouterState({ select: (s) => s.location.href });
  const enabled = workspaceUrlsEnabled() && isWorkspaceScopedPath(pathname);
  const { isLoaded, isSignedIn, orgId, orgSlug } = useAuth();
  const { urlRef, activeRef } = useWorkspaceUrlState();
  const {
    isLoaded: listLoaded,
    setActive,
    userMemberships,
  } = useOrganizationList({ userMemberships: { infinite: true, pageSize: 50 } });
  // Captured once per page load, like the shell's own copy.
  const [pendingOrgId] = useState(() => peekPendingOrganization());
  const [settled, setSettled] = useState<{ ref: string; orgId: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const activatingRef = useRef(false);

  const memberships = useMemo<WorkspaceLinkMembership[]>(
    () =>
      (userMemberships?.data ?? []).map((m) => ({
        id: m.organization.id,
        slug: m.organization.slug,
        name: m.organization.name,
      })),
    [userMemberships?.data],
  );
  const allMemberships =
    listLoaded && userMemberships && !userMemberships.isLoading && !userMemberships.hasNextPage ? memberships : null;

  const decision =
    enabled && isLoaded && isSignedIn
      ? decideWorkspaceUrl({ urlRef, orgId, orgSlug, pendingOrgId, memberships: allMemberships, settled })
      : null;
  const following = decision?.kind === 'follow';
  const readyRef = decision?.kind === 'ready' || following ? decision.ref : null;
  const activateOrgId = decision?.kind === 'activate' ? decision.orgId : null;

  // Memberships are paged; only decide once every page is in.
  const needsMore = (decision?.kind === 'wait' || decision?.kind === 'activate') && !allMemberships;
  useEffect(() => {
    if (needsMore && userMemberships?.hasNextPage && !userMemberships.isFetching) userMemberships.fetchNext();
  }, [needsMore, userMemberships]);

  // Settled: links carry the workspace, and the address bar names it by slug
  // (a bare path, an org id or another casing is replaced in place).
  useLayoutEffect(() => {
    if (!readyRef || !orgId) return;
    setActiveWorkspaceRef(readyRef);
    // Following, the URL names the old workspace until the replace below
    // lands; it settles on the new one from there.
    if (!following) {
      setSettled((prev) => (prev?.ref === readyRef && prev.orgId === orgId ? prev : { ref: readyRef, orgId }));
    }
    // The org pending when this page loaded is active now, or lost to the URL.
    if (pendingOrgId) clearPendingOrganizationIf(pendingOrgId);
    if (parseWorkspacePath(window.location.pathname)?.ref !== readyRef) {
      // Not navigate(): a same-location navigation never writes history.
      router.history.replace(workspacePath(readyRef, target), router.history.location.state);
    }
  }, [readyRef, following, pendingOrgId, orgId, router, target]);

  useEffect(() => {
    if (!activateOrgId || !setActive || activatingRef.current) return;
    activatingRef.current = true;
    const switching = Boolean(orgId) && orgId !== activateOrgId;
    // Survives Clerk coming back with the previous org after the reload.
    setPendingOrganization(activateOrgId);
    setActive({ organization: activateOrgId })
      .then(() => {
        if (!switching) {
          // No reload to survive, and a stale id would win a later bare-path load.
          clearPendingOrganizationIf(activateOrgId);
          return; // nothing loaded yet: Clerk's orgId updates and the URL is ready
        }
        // The reload hydrates from that org's own persisted cache (FE-014).
        window.location.replace(window.location.href);
      })
      .catch(() => {
        // Leave behind only what was pending before: a later load must not
        // try again to activate an org this page failed to.
        if (activateOrgId !== pendingOrgId) clearPendingOrganizationIf(activateOrgId);
        activatingRef.current = false;
        setFailed(true);
      });
  }, [activateOrgId, setActive, orgId, pendingOrgId]);

  let status: WorkspaceUrlGateStatus;
  if (!decision || decision.kind === 'skip') status = 'off';
  else if (failed) status = 'error';
  else if (decision.kind === 'not-found') status = 'not-found';
  else if (decision.kind === 'follow') status = 'ready'; // already rendered; the page navigates away
  else if (decision.kind === 'ready' && activeRef === decision.ref) status = 'ready';
  else status = 'blocked';

  return { status, ownsActivation: enabled && urlRef !== null, memberships, target };
}
