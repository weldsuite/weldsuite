/**
 * App-API app-access domain client — `/api/app-catalog/:code/access-request`.
 *
 * Apps that are on request only (`app_catalog.requires_approval`, WeldReach
 * first) are requested here by a workspace OWNER/ADMIN and approved by
 * WeldSuite staff in the admin console. Lives in app-api (core) because the
 * module worker itself refuses every request until access is approved.
 */

import type { ClientApi, DataResponse } from '../types';
import type { AppAccessRequestInput, AppAccessView } from '../schemas/reach';

export function createAppAccessApi(api: ClientApi) {
  const path = (appCode: string) => `/app-catalog/${encodeURIComponent(appCode)}/access-request`;
  return {
    /** `data` is null when the workspace never asked. */
    get(appCode: string): Promise<DataResponse<AppAccessView | null>> {
      return api.get<DataResponse<AppAccessView | null>>(path(appCode));
    },

    /** Files a request, or files it again after a rejection. 409 while one is pending, approved or suspended. */
    request(appCode: string, input: AppAccessRequestInput): Promise<DataResponse<AppAccessView>> {
      return api.post<DataResponse<AppAccessView>>(path(appCode), input);
    },
  };
}

export type AppAccessApi = ReturnType<typeof createAppAccessApi>;
