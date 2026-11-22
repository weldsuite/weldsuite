/**
 * WeldCRM settings domain client: `/api/crm-settings` (Rust backend, the
 * Kubernetes editions only).
 */

import type { ClientApi, DataResponse } from '../types';
import type { CrmSettings, UpdateCrmSettingsInput } from '../schemas/crm-settings';

export function createCrmSettingsApi(api: ClientApi) {
  return {
    /** The settings, defaults filled in. */
    get(): Promise<DataResponse<CrmSettings>> {
      return api.get<DataResponse<CrmSettings>>('/crm-settings');
    },

    /** Changes the keys given (`settings:manage`); the answer is the new settings. */
    update(input: UpdateCrmSettingsInput): Promise<DataResponse<CrmSettings>> {
      return api.put<DataResponse<CrmSettings>>('/crm-settings', input);
    },
  };
}

export type CrmSettingsApi = ReturnType<typeof createCrmSettingsApi>;
