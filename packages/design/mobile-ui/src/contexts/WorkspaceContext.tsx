import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { useOrganizationList, useOrganization } from '@clerk/expo';
import { useClerkAuth } from './ClerkAuthContext';
import type { Workspace, WorkspaceWithMembership } from '../types';

interface WorkspaceApi {
  getCurrentWorkspace: () => Promise<{ success: boolean; data?: Workspace }>;
  getUserWorkspaces: () => Promise<{ success: boolean; data?: WorkspaceWithMembership[] }>;
}

interface WorkspaceContextValue {
  currentWorkspace: Workspace | null;
  workspaces: WorkspaceWithMembership[];
  isLoading: boolean;
  isLoadingWorkspaces: boolean;
  error: Error | null;
  refreshWorkspace: () => Promise<void>;
  refreshWorkspaces: () => Promise<void>;
  switchWorkspace: (clerkOrgId: string) => Promise<void>;
  hasMultipleWorkspaces: boolean;
}

const WorkspaceContext = createContext<WorkspaceContextValue | undefined>(undefined);

interface WorkspaceProviderProps {
  children: React.ReactNode;
  api: WorkspaceApi;
}

export function WorkspaceProvider({ children, api }: WorkspaceProviderProps) {
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
  }, [user, organizationId, organization, api]);

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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- userMemberships.data is a new ref every render; use user as stable dep
  }, [user, api]);

  const refreshWorkspace = useCallback(async () => {
    if (!user || !organizationId) return;
    await fetchCurrentWorkspace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, organizationId]);

  const refreshWorkspaces = useCallback(async () => {
    if (!user) return;
    await fetchWorkspaces();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const switchWorkspace = useCallback(async (clerkOrgId: string) => {
    if (!setActive) {
      throw new Error('Organization switching not available');
    }

    try {
      await setActive({ organization: clerkOrgId });
    } catch (err) {
      console.error('Failed to switch workspace:', err);
      throw err instanceof Error ? err : new Error('Failed to switch workspace');
    }
  }, [setActive]);

  useEffect(() => {
    if (user && organizationId) {
      fetchCurrentWorkspace();
    } else {
      setCurrentWorkspace(null);
      setIsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, organizationId]);

  useEffect(() => {
    if (user) {
      fetchWorkspaces();
    } else {
      setWorkspaces([]);
      setIsLoadingWorkspaces(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

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
