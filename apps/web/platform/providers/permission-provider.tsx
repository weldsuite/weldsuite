/**
 * Platform Permission Provider
 *
 * Fetches the current user's permissions from the API via TanStack Query,
 * then feeds them to @weldsuite/permissions PermissionProvider.
 *
 * Checks are evaluated for the module in the URL (`/weldcrm/...` → weldcrm),
 * matching the X-Weld-App header the server sees for the same screen.
 */

import { useQuery } from '@tanstack/react-query';
import { PermissionProvider } from '@weldsuite/permissions/react';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { appFromPathname } from '@/lib/apps/current-app';
import { usePathname } from '@/lib/router';
import { useAuth } from '@clerk/clerk-react';

interface PermissionResponse {
  permissions: string[];
  denies?: string[];
  role: string;
  roleId: string | null;
  isOwner: boolean;
}

const NO_KEYS: string[] = [];

export function PlatformPermissionProvider({ children }: { children: React.ReactNode }) {
  const { getClient } = useAppApiClient();
  const { isSignedIn, orgId } = useAuth();
  const app = appFromPathname(usePathname());

  const { data, isLoading } = useQuery({
    queryKey: ['my-permissions', orgId],
    queryFn: async () => {
      const client = await getClient();
      // app-api GET /api/me/permissions — same resolver as the requirePermission()
      // middleware (was api-worker GET /settings/my-permissions).
      const res = await client.get<{ data: PermissionResponse }>('/me/permissions');
      return res.data;
    },
    enabled: !!isSignedIn && !!orgId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
  });

  return (
    <PermissionProvider
      permissions={data?.permissions ?? NO_KEYS}
      denies={data?.denies ?? NO_KEYS}
      isLoading={isLoading}
      role={data?.role ?? ''}
      app={app}
    >
      {children}
    </PermissionProvider>
  );
}
