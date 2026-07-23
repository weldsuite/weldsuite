import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { useOrganizationList, useOrganization } from '@clerk/expo';
import api, { Workspace, WorkspaceWithMembership } from '@/services/api';
import { useClerkAuth } from './ClerkAuthContext';

interface WorkspaceContextValue {
  // Current workspace (from master DB)
  currentWorkspace: Workspace | null;
  // All workspaces the user is a member of
  workspaces: WorkspaceWithMembership[];
  // Loading states
  isLoading: boolean;
  isLoadingWorkspaces: boolean;
  // Error state
  error: Error | null;
  // Actions
  refreshWorkspace: () => Promise<void>;
  refreshWorkspaces: () => Promise<void>;
  switchWorkspace: (clerkOrgId: string) => Promise<void>;
  // Helper to check if user has multiple workspaces
  hasMultipleWorkspaces: boolean;
}

const WorkspaceContext = createContext<WorkspaceContextValue | undefined>(undefined);

interface WorkspaceProviderProps {
  children: React.ReactNode;
}

export function WorkspaceProvider({ children }: WorkspaceProviderProps) {
  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceWithMembership[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingWorkspaces, setIsLoadingWorkspaces] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const { user, organizationId } = useClerkAuth();
  const { organization } = useOrganization();
  const { setActive, userMemberships } = useOrganizationList({
    userMemberships: {
      infinite: true,
    },
  });

  // Fetch current workspace details from master DB
  const fetchCurrentWorkspace = useCallback(async () => {
    if (!user || !organizationId) {
      setCurrentWorkspace(null);
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      const response = await api.getCurrentWorkspace();
      if (response.success && response.data) {
        setCurrentWorkspace(response.data);
      } else {
        // Fallback to Clerk organization data if workspace not found in master DB
        setCurrentWorkspace({
          id: organization?.id || organizationId,
          clerkOrgId: organizationId,
          name: organization?.name || 'Workspace',
          slug: organization?.slug || 'workspace',
          imageUrl: organization?.imageUrl,
          isActive: true,
        });
      }
    } catch (err) {
      console.error('Failed to fetch workspace:', err);
      setError(err instanceof Error ? err : new Error('Failed to fetch workspace'));
      // Fallback to Clerk organization data on error
      if (organization) {
        setCurrentWorkspace({
          id: organization.id,
          clerkOrgId: organizationId,
          name: organization.name,
          slug: organization.slug || 'workspace',
          imageUrl: organization.imageUrl,
          isActive: true,
        });
      }
    } finally {
      setIsLoading(false);
    }
  }, [user, organizationId, organization]);

  // Fetch all workspaces the user is a member of
  const fetchWorkspaces = useCallback(async () => {
    if (!user) {
      setWorkspaces([]);
      setIsLoadingWorkspaces(false);
      return;
    }

    try {
      setIsLoadingWorkspaces(true);
      const response = await api.getUserWorkspaces();
      if (response.success && response.data) {
        setWorkspaces(response.data);
      } else {
        // Fallback to Clerk memberships if master DB query fails
        const memberships = userMemberships?.data || [];
        const fallbackWorkspaces: WorkspaceWithMembership[] = memberships.map((m) => ({
          id: m.organization.id,
          clerkOrgId: m.organization.id,
          name: m.organization.name,
          slug: m.organization.slug || 'workspace',
          imageUrl: m.organization.imageUrl,
          isActive: true,
          role: m.role,
          membershipStatus: 'ACTIVE',
        }));
        setWorkspaces(fallbackWorkspaces);
      }
    } catch (err) {
      console.error('Failed to fetch workspaces:', err);
      // Fallback to Clerk memberships on error
      const memberships = userMemberships?.data || [];
      const fallbackWorkspaces: WorkspaceWithMembership[] = memberships.map((m) => ({
        id: m.organization.id,
        clerkOrgId: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug || 'workspace',
        imageUrl: m.organization.imageUrl,
        isActive: true,
        role: m.role,
        membershipStatus: 'ACTIVE',
      }));
      setWorkspaces(fallbackWorkspaces);
    } finally {
      setIsLoadingWorkspaces(false);
    }
  }, [user, userMemberships?.data]);

  // Refresh current workspace
  const refreshWorkspace = useCallback(async () => {
    if (!user || !organizationId) return;
    await fetchCurrentWorkspace();
  }, [user, organizationId, fetchCurrentWorkspace]);

  // Refresh all workspaces
  const refreshWorkspaces = useCallback(async () => {
    if (!user) return;
    await fetchWorkspaces();
  }, [user, fetchWorkspaces]);

  // Switch to a different workspace
  const switchWorkspace = useCallback(async (clerkOrgId: string) => {
    if (!setActive) {
      throw new Error('Organization switching not available');
    }

    try {
      // Use Clerk's setActive to switch organization
      await setActive({ organization: clerkOrgId });
      // The workspace will be refetched automatically via the useEffect when organizationId changes
    } catch (err) {
      console.error('Failed to switch workspace:', err);
      throw err instanceof Error ? err : new Error('Failed to switch workspace');
    }
  }, [setActive]);

  // Fetch workspace when user or organization changes
  useEffect(() => {
    if (user && organizationId) {
      fetchCurrentWorkspace();
    } else {
      setCurrentWorkspace(null);
      setIsLoading(false);
    }
  }, [user, organizationId, fetchCurrentWorkspace]);

  // Fetch workspaces list when user changes
  useEffect(() => {
    if (user) {
      fetchWorkspaces();
    } else {
      setWorkspaces([]);
      setIsLoadingWorkspaces(false);
    }
  }, [user, fetchWorkspaces]);

  const hasMultipleWorkspaces = workspaces.length > 1;

  const value = useMemo(() => ({
    currentWorkspace,
    workspaces,
    isLoading,
    isLoadingWorkspaces,
    error,
    refreshWorkspace,
    refreshWorkspaces,
    switchWorkspace,
    hasMultipleWorkspaces,
  }), [
    currentWorkspace,
    workspaces,
    isLoading,
    isLoadingWorkspaces,
    error,
    refreshWorkspace,
    refreshWorkspaces,
    switchWorkspace,
    hasMultipleWorkspaces,
  ]);

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (context === undefined) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider');
  }
  return context;
}

export default WorkspaceContext;
