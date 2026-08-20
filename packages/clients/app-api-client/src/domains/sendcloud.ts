import type { ClientApi, DataResponse } from '../types';
import type {
  SendcloudConnectInput,
  SendcloudSettingsPublic,
  UpdateSendcloudSettingsInput,
} from '../schemas/sendcloud';

export function createSendcloudApi(api: ClientApi) {
  return {
    get(): Promise<DataResponse<SendcloudSettingsPublic>> {
      return api.get('/sendcloud');
    },

    connect(data: SendcloudConnectInput): Promise<DataResponse<SendcloudSettingsPublic>> {
      return api.put('/sendcloud/connect', data);
    },

    sync(): Promise<DataResponse<SendcloudSettingsPublic>> {
      return api.post('/sendcloud/sync', {});
    },

    update(data: UpdateSendcloudSettingsInput): Promise<DataResponse<SendcloudSettingsPublic>> {
      return api.patch('/sendcloud', data);
    },

    disconnect(): Promise<void> {
      return api.delete('/sendcloud');
    },
  };
}
