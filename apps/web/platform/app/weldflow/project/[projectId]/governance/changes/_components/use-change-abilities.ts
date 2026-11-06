import { usePermissions } from '@weldsuite/permissions/react';
import { useAuth } from '@/lib/auth';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import type { ChangeAbilities } from './change-detail';

/**
 * What the member may do with the change requests of the project around the
 * caller (the page, or the panel's own `ProjectPermissionProvider`).
 */
export function useChangeAbilities(): {
  abilities: ChangeAbilities;
  /** Start a change request. */
  canCreate: boolean;
  /** Edit the approval rules; everybody else reads them. */
  canEditRules: boolean;
  userId: string | null | undefined;
} {
  const { can } = usePermissions();
  const { canWrite, isAdmin } = useProjectPermissions();
  const { userId } = useAuth();
  return {
    abilities: { write: canWrite && can('projects:update'), remove: can('projects:delete'), manage: isAdmin },
    canCreate: canWrite && can('projects:create'),
    canEditRules: isAdmin && can('projects:update'),
    userId,
  };
}
