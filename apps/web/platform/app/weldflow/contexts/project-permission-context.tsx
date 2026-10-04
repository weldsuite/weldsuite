
import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react';
import { projectsApi } from '@/app/weldflow/lib/api-client';
import { useTranslations } from '@weldsuite/i18n/client';

interface ProjectPermission {
  role: string | null;
  canRead: boolean;
  canWrite: boolean;
  isAdmin: boolean;
}

interface ProjectPermissionContextType {
  permissions: ProjectPermission | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  // Convenience methods
  canRead: boolean;
  canWrite: boolean;
  isAdmin: boolean;
  isViewer: boolean;
  role: string | null;
}

const defaultPermissions: ProjectPermissionContextType = {
  permissions: null,
  isLoading: true,
  error: null,
  refetch: async () => {},
  canRead: false,
  canWrite: false,
  isAdmin: false,
  isViewer: false,
  role: null,
};

const ProjectPermissionContext = createContext<ProjectPermissionContextType>(defaultPermissions);

interface ProjectPermissionProviderProps {
  projectId: string;
  children: ReactNode;
}

export function ProjectPermissionProvider({ projectId, children }: Readonly<ProjectPermissionProviderProps>) {
  const st = useTranslations();
  // Tag the permissions with the project they belong to: a project switch must
  // never show the previous project's grants, while a refetch for the same
  // project keeps showing the last loaded ones (no read-only flicker).
  const [loaded, setLoaded] = useState<{ projectId: string; permissions: ProjectPermission } | null>(null);
  const [isFetching, setIsFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const latestProjectIdRef = useRef(projectId);
  latestProjectIdRef.current = projectId;

  const fetchPermissions = useCallback(async () => {
    if (!projectId) {
      setIsFetching(false);
      return;
    }

    setIsFetching(true);
    setError(null);

    // Default to no permissions on error
    let next: ProjectPermission = { role: null, canRead: false, canWrite: false, isAdmin: false };
    let failure: string | null = null;
    try {
      const result = await projectsApi.getPermissions(projectId);
      if (result.success && result.data) {
        next = result.data;
      } else {
        failure = result.error || st('sweep.weldflow.permissionContext.loadFailed');
      }
    } catch (err) {
      console.error('Error fetching permissions:', err);
      failure = st('sweep.weldflow.permissionContext.loadFailed');
    }

    // The user may have navigated to another project while this was in flight.
    if (latestProjectIdRef.current !== projectId) return;
    setError(failure);
    setLoaded({ projectId, permissions: next });
    setIsFetching(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `st` is a new function identity every render; including it would re-trigger the fetch effect on every render.
  }, [projectId]);

  useEffect(() => {
    fetchPermissions();
  }, [fetchPermissions]);

  const value = useMemo<ProjectPermissionContextType>(() => {
    const permissions = loaded?.projectId === projectId ? loaded.permissions : null;
    const isLoading = projectId ? isFetching || !permissions : false;
    return {
      permissions,
      isLoading,
      error,
      refetch: fetchPermissions,
      // Read-only until the server has answered: a write control that flashes up
      // for a viewer is worse than one that appears a moment late for a writer.
      // A refetch for the same project keeps the last loaded grants.
      canRead: permissions?.canRead ?? false,
      canWrite: permissions?.canWrite ?? false,
      isAdmin: permissions?.isAdmin ?? false,
      // A workspace admin can hold a 'viewer' member row and still write.
      isViewer: !isLoading && permissions?.role === 'viewer' && !permissions.canWrite,
      role: permissions?.role ?? null,
    };
  }, [loaded, projectId, isFetching, error, fetchPermissions]);

  return (
    <ProjectPermissionContext.Provider value={value}>
      {children}
    </ProjectPermissionContext.Provider>
  );
}

export function useProjectPermissions() {
  const context = useContext(ProjectPermissionContext);
  if (!context) {
    throw new Error('useProjectPermissions must be used within a ProjectPermissionProvider');
  }
  return context;
}

// Export the context for testing purposes
export { ProjectPermissionContext };
