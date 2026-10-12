/**
 * Whether an app in the store has to be requested before it can be installed
 * (`app_catalog.requires_approval`, WeldReach first): the catalog entry says so,
 * the workspace's access request has the live state.
 */

import type { AvailableApp } from '@/hooks/queries/use-settings-queries';
import { useAppAccessRequest } from '@/hooks/queries/use-app-access-queries';
import { getAppAccessInfo, parseAppAccessState } from './app-access-state';

export function useAppAccessGate(app: AvailableApp) {
  const accessInfo = getAppAccessInfo(app);
  const request = useAppAccessRequest(app.code, accessInfo.requiresApproval);
  const view = request.data;
  const status = view === undefined ? accessInfo.status : parseAppAccessState(view?.status);
  const needsAccess = accessInfo.requiresApproval && !app.isInstalled && status !== 'approved';
  return { status, view, needsAccess };
}
