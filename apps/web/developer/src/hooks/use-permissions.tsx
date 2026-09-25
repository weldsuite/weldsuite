import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import { PermissionProvider, usePermissions } from '@weldsuite/permissions/react';
import type { ReactNode } from 'react';
import { useAppApiClient } from '@/lib/api';

interface PermissionResponse {
  permissions: string[];
  role: string;
  roleId: string | null;
  isOwner: boolean;
}

export function DeveloperPermissionProvider({ children }: Readonly<{ children: ReactNode }>) {
  const { getClient } = useAppApiClient();
  const { isSignedIn, orgId } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ['my-permissions', orgId],
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: PermissionResponse }>('/me/permissions');
      return res.data;
    },
    enabled: !!isSignedIn && !!orgId,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  return (
    <PermissionProvider
      permissions={data?.permissions ?? []}
      isLoading={isLoading || (!!isSignedIn && !!orgId && !data)}
      role={data?.role ?? ''}
    >
      {children}
    </PermissionProvider>
  );
}

export function useCanDevelopApps(): { canDevelop: boolean; isLoading: boolean } {
  const { can, isOwner, isLoading } = usePermissions();
  return {
    canDevelop: isOwner || can('weldapps:develop'),
    isLoading,
  };
}

export function useCanPublishApps(): boolean {
  const { can, isOwner } = usePermissions();
  return isOwner || can('weldapps:publish');
}
