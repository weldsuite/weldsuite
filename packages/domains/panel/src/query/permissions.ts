import type { PanelQueryKind } from '@weldsuite/app-api-client/schemas/weldpanel-query';

/**
 * The permissions a query kind needs. `sessions` shows what visitors did and
 * saw, so it also needs `panel_recordings:read` (kept apart from reports, like
 * WeldPass's `read` and `reveal`).
 */
export function requiredPanelPermissions(kind: PanelQueryKind): string[] {
  return kind === 'sessions' ? ['panel_reports:read', 'panel_recordings:read'] : ['panel_reports:read'];
}
