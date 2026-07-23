
import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
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

export function ProjectPermissionProvider({ projectId, children }: ProjectPermissionProviderProps) {
  const st = useTranslations();
  const [permissions, setPermissions] = useState<ProjectPermission | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPermissions = useCallback(async () => {
    if (!projectId) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await projectsApi.getPermissions(projectId);
      if (result.success && result.data) {
        setPermissions(result.data);
      } else {
        setError(result.error || st('sweep.weldflow.permissionContext.loadFailed'));
        // Default to no permissions on error
        setPermissions({
          role: null,
          canRead: false,
          canWrite: false,
          isAdmin: false,
        });
      }
    } catch (err) {
      console.error('Error fetching permissions:', err);
      setError(st('sweep.weldflow.permissionContext.loadFailed'));
      setPermissions({
        role: null,
        canRead: false,
        canWrite: false,
        isAdmin: false,
      });
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchPermissions();
  }, [fetchPermissions]);

  const value: ProjectPermissionContextType = {
    permissions,
    isLoading,
    error,
    refetch: fetchPermissions,
    // While loading, assume user has permissions (optimistic UI)
    // This prevents buttons from being hidden during initial load
    canRead: isLoading ? true : (permissions?.canRead ?? false),
    canWrite: isLoading ? true : (permissions?.canWrite ?? false),
    isAdmin: isLoading ? true : (permissions?.isAdmin ?? false),
    isViewer: !isLoading && permissions?.role === 'viewer',
    role: permissions?.role ?? null,
  };

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
