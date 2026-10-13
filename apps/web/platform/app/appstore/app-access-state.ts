/**
 * How the app store treats apps that are on request only
 * (`app_catalog.requires_approval`, WeldReach first).
 *
 * app-api adds `requiresApproval` and `accessStatus` to each catalog entry;
 * both are optional here, so an older response simply reads as "no approval
 * needed" and the normal Install button shows.
 */

import type { SoftTone } from '@/components/shared/soft-badge';
import type { AvailableApp } from '@/hooks/queries/use-settings-queries';

export type AppAccessState = 'none' | 'requested' | 'approved' | 'rejected' | 'suspended' | 'revoked';

const ACCESS_STATES: readonly AppAccessState[] = ['none', 'requested', 'approved', 'rejected', 'suspended', 'revoked'];

export function parseAppAccessState(value: unknown): AppAccessState {
  return typeof value === 'string' && (ACCESS_STATES as readonly string[]).includes(value)
    ? (value as AppAccessState)
    : 'none';
}

export interface AppAccessInfo {
  requiresApproval: boolean;
  status: AppAccessState;
}

export function getAppAccessInfo(app: Pick<AvailableApp, 'requiresApproval' | 'accessStatus'>): AppAccessInfo {
  return { requiresApproval: app.requiresApproval === true, status: parseAppAccessState(app.accessStatus) };
}

/** Request access (again) is offered when nothing is pending or granted. */
export function canRequestAccess(status: AppAccessState): boolean {
  return status === 'none' || status === 'rejected' || status === 'revoked';
}

/** Badge tone for the state shown on an app tile: pending is amber, suspended or revoked red. */
export function accessBadgeTone(status: AppAccessState): SoftTone {
  if (status === 'requested') return 'warning';
  if (status === 'suspended' || status === 'revoked') return 'danger';
  return 'neutral';
}

/** Install is only offered once staff approved the workspace (or the app needs no approval). */
export function canInstallApp(info: AppAccessInfo): boolean {
  return !info.requiresApproval || info.status === 'approved';
}
