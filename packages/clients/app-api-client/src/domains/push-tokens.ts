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

export interface PushTokenStatus {
  deviceId: string;
  platform: string;
  appCode: string;
  tokenSuffix: string | null;
  lastUsedAt: string | null;
  updatedAt: string | null;
}

export interface TestPushResult {
  sent: number;
  failed: number;
  errors: string[];
}

export function createPushTokensApi(api: ClientApi) {
  return {
    /** Active tokens for the signed-in user (token values masked). */
    list(): Promise<DataResponse<PushTokenStatus[]>> {
      return api.get<DataResponse<PushTokenStatus[]>>('/push-tokens');
    },

    register(data: RegisterPushTokenInput): Promise<DataResponse<RegisterPushTokenResult>> {
      return api.post<DataResponse<RegisterPushTokenResult>>('/push-tokens', data);
    },

    /** Fire a real Expo push to this user's registered devices. */
    test(): Promise<DataResponse<TestPushResult>> {
      return api.post<DataResponse<TestPushResult>>('/push-tokens/test', {});
    },

    unregister(deviceId: string): Promise<DataResponse<UnregisterPushTokenResult>> {
      return api.delete<DataResponse<UnregisterPushTokenResult>>(
        `/push-tokens${buildQueryString({ deviceId })}`,
      );
    },
  };
}
