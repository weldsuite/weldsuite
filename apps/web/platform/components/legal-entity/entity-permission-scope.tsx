import { useMemo } from 'react';
import { PermissionProvider, usePermissionsMaybe } from '@weldsuite/permissions/react';
import { useMyLegalEntityAccess } from '@/hooks/queries/use-legal-entities-queries';

/**
 * Inside WeldBooks and WeldHR, a member acts with the role they hold in the
 * selected legal entity, which can differ from their workspace role. This
 * scope swaps the permission context of its subtree for the member's effective
 * permissions in `entityId` (`GET /legal-entities/:id/my-access`), so buttons
 * and menus match what the API allows. Everything else about the context (app,
 * enforcement, role label) is the workspace's.
 *
 * While the entity's access loads, checks answer "no" (so no action shows
 * that the API would refuse); if it cannot be loaded, the workspace
 * permissions stay in force. Without an entity there is nothing to scope.
 */
export function EntityPermissionScope({
  entityId,
  children,
}: Readonly<{ entityId: string | null | undefined; children: React.ReactNode }>) {
  const parent = usePermissionsMaybe();
  const { data: access, isLoading } = useMyLegalEntityAccess(entityId);

  const permissions = useMemo(
    () => (access ? (access.isOwner ? ['*', ...access.permissions] : access.permissions) : []),
    [access],
  );
  const denies = useMemo(() => access?.denies ?? [], [access]);

  if (!parent || !entityId) return <>{children}</>;
  if (!access && !isLoading) return <>{children}</>;

  return (
    <PermissionProvider
      permissions={permissions}
      denies={denies}
      isLoading={isLoading || parent.isLoading}
      role={parent.role}
      app={parent.app}
      enforceApp={parent.appEnforced}
    >
      {children}
    </PermissionProvider>
  );
}
