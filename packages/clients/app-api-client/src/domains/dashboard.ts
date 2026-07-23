/**
 * App-API dashboard domain client — read-only `/api/dashboard/*`.
 *
 * Mirrors apps/workers/app-api/src/routes/dashboard/index.ts. Only the installed-apps
 * list is wrapped here — the WeldChat `_layout` needs the installed-apps list
 * to gate module navigation. `list()` returns the active app codes scoped to
 * the caller's role.
 */

import type { ClientApi, DataResponse } from '../types';

export function createDashboardApi(api: ClientApi) {
  return {
    installedApps(): Promise<DataResponse<string[]>> {
      return api.get<DataResponse<string[]>>('/dashboard/installed-apps');
    },
  };
}
