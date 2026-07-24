
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useAuth, useOrganizationList } from '@clerk/clerk-react';
import { useAppApiClient } from '@/lib/api/use-app-api';

interface Workspace {
  id: string;
  clerkOrgId?: string;
  name: string;
  slug: string;
  description?: string | null;
  role?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Row shape returned by app-api `GET /api/workspaces`. Note `id` is the CLERK
 * ORG id (the identifier clients switch on); the internal master-DB id is
 * `workspaceId`.
 */
interface WorkspaceSummary {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  role: string;
}

interface WorkspaceContextType {
  currentWorkspace: Workspace | null;
  workspaces: Workspace[];
  loading: boolean;
  error: string | null;
  switchWorkspace: (workspaceId: string) => Promise<void>;
  createWorkspace: (data: Partial<Workspace>) => Promise<void>;
  refreshWorkspaces: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextType | undefined>(undefined);

/**
 * Map an app-api workspace summary onto the context's Workspace shape.
 *
 * `id` is deliberately the Clerk org id, not the internal `workspaceId`:
 * `useWorkspaceId()` feeds call sites that fall back to Clerk's `orgId`
 * (e.g. weldmeet's `useWorkspaceId() || orgId`), so the two must be the same
 * kind of identifier.
 */
function toWorkspace(summary: WorkspaceSummary): Workspace {
  return {
    id: summary.id,
    clerkOrgId: summary.id,
    name: summary.name,
    slug: summary.slug,
    role: summary.role,
  };
}

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [currentWorkspace, setCurrentWorkspaceState] = useState<Workspace | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { isLoaded, isSignedIn, orgId } = useAuth();
  const orgList = useOrganizationList({ userMemberships: true });
  const { getClient } = useAppApiClient();

  // Fetch workspaces
  const fetchWorkspaces = useCallback(async () => {
    try {
      setLoading(true);
      const client = await getClient();
      // app-api GET /api/workspaces — the user's active memberships, read from
      // the master DB. There is no "current workspace" endpoint: Clerk's active
      // organization IS the current workspace, so resolve it from the list.
      const result = await client.get<{ data: WorkspaceSummary[] }>('/workspaces');
      const workspacesList = (result?.data ?? []).map(toWorkspace);

      setWorkspaces(workspacesList);

      const currentWs =
        (orgId ? workspacesList.find((w) => w.clerkOrgId === orgId) : undefined) ??
        workspacesList[0] ??
        null;

      if (currentWs) {
        setCurrentWorkspaceState(currentWs);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workspaces');
    } finally {
      setLoading(false);
    }
  }, [getClient, orgId]);

  // Switch workspace
  const switchWorkspace = useCallback(async (workspaceId: string) => {
    try {
      // Find the workspace from the list (support both internal ID and Clerk org ID)
      const workspace = workspaces.find(w => w.id === workspaceId || w.clerkOrgId === workspaceId);
      const targetOrgId = workspace?.clerkOrgId ?? workspaceId;

      if (!orgList?.setActive) {
        setError('Workspace not found');
        return;
      }

      // Clerk's active organization is the single source of truth for which
      // workspace is current — every app-api request resolves its tenant from
      // the org claim on the JWT, so there is no server-side cookie to set.
      await orgList.setActive({ organization: targetOrgId });
      if (workspace) setCurrentWorkspaceState(workspace);

      // Drop the persisted TanStack Query cache so the new workspace doesn't
      // hydrate with the previous workspace's data after the reload.
      try { window.localStorage.removeItem('weldsuite:query-cache'); } catch {
        // Ignore — best-effort cache clear, a full page reload follows regardless.
      }
      // Full page reload to ensure all data refreshes with new org context
      window.location.href = '/';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to switch workspace');
    }
  }, [workspaces, orgList]);

  // Create workspace
  const createWorkspace = useCallback(async (data: Partial<Workspace>) => {
    if (!data.name) {
      setError('Workspace name is required');
      throw new Error('Workspace name is required');
    }

    try {
      const client = await getClient();
      // app-api POST /api/onboarding/create-workspace provisions the Clerk org,
      // the master workspace row and the tenant database in one call. It derives
      // the slug server-side and takes no description, so those fields on
      // `data` are ignored here.
      const result = await client.post<{
        data: { organizationId: string; workspaceId: string; ready: boolean };
      }>('/onboarding/create-workspace', { name: data.name });

      const created = result?.data;
      if (created) {
        const workspace: Workspace = {
          id: created.organizationId,
          clerkOrgId: created.organizationId,
          name: data.name,
          slug: data.slug ?? '',
        };
        setWorkspaces(prev => [...prev, workspace]);
        setCurrentWorkspaceState(workspace);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to create workspace';
      setError(errorMessage);
      throw err;
    }
  }, [getClient]);

  // Initial load - only fetch when Clerk is loaded and user is signed in
  useEffect(() => {
    if (!isLoaded || !isSignedIn) {
      setLoading(false);
      return;
    }
    fetchWorkspaces();
  }, [isLoaded, isSignedIn, fetchWorkspaces]);

  const value = {
    currentWorkspace,
    workspaces,
    loading,
    error,
    switchWorkspace,
    createWorkspace,
    refreshWorkspaces: fetchWorkspaces,
  };

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (context === undefined) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider');
  }
  return context;
}

// Helper hook to get current workspace ID for API calls
export function useWorkspaceId() {
  const { currentWorkspace } = useWorkspace();
  return currentWorkspace?.id || null;
}
