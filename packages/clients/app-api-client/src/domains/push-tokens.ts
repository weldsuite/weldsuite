/**
 * App-API push-tokens domain client — flat `/api/push-tokens`.
 */

import type { ClientApi, DataResponse } from '../types';
import { buildQueryString } from '../types';
import type { RegisterPushTokenInput } from '../schemas/push-tokens';

export interface RegisterPushTokenResult {
  deviceId: string;
  platform: string;
  registered: boolean;
}

export interface UnregisterPushTokenResult {
  deviceId: string;
  unregistered: boolean;
}

export function createPushTokensApi(api: ClientApi) {
  return {
    register(data: RegisterPushTokenInput): Promise<DataResponse<RegisterPushTokenResult>> {
      return api.post<DataResponse<RegisterPushTokenResult>>('/push-tokens', data);
    },

    unregister(deviceId: string): Promise<DataResponse<UnregisterPushTokenResult>> {
      return api.delete<DataResponse<UnregisterPushTokenResult>>(
        `/push-tokens${buildQueryString({ deviceId })}`,
      );
    },
  };
}
