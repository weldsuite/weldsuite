import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  Notification,
  ListNotificationsQuery,
  UnreadCountResponse,
  SuccessResponse,
  BatchSuccessResponse,
} from '../schemas/notifications';

export function createNotificationsApi(api: ClientApi) {
  return {
    list(params: ListNotificationsQuery = { limit: 25 }): Promise<ListResponse<Notification>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<Notification>>(`/notifications${query}`);
    },

    get(id: string): Promise<DataResponse<Notification>> {
      return api.get<DataResponse<Notification>>(`/notifications/${id}`);
    },

    unreadCount(): Promise<DataResponse<UnreadCountResponse>> {
      return api.get<DataResponse<UnreadCountResponse>>('/notifications/unread-count');
    },

    markAsRead(id: string): Promise<DataResponse<SuccessResponse>> {
      return api.post<DataResponse<SuccessResponse>>(`/notifications/${id}/read`);
    },

    markAllAsRead(): Promise<DataResponse<SuccessResponse>> {
      return api.post<DataResponse<SuccessResponse>>('/notifications/read-all');
    },

    markBatchAsRead(notificationIds: string[]): Promise<DataResponse<BatchSuccessResponse>> {
      return api.post<DataResponse<BatchSuccessResponse>>(
        '/notifications/read-batch',
        { notificationIds },
      );
    },

    delete(id: string): Promise<DataResponse<SuccessResponse>> {
      return api.delete<DataResponse<SuccessResponse>>(`/notifications/${id}`);
    },

    deleteBatch(_notificationIds: string[]): Promise<DataResponse<BatchSuccessResponse>> {
      // Legacy parity: the api-worker route requires a body but the worker
      // ClientApi.delete signature is body-less. The legacy implementation
      // had the same shape — kept here unchanged to preserve current behaviour.
      return api.delete<DataResponse<BatchSuccessResponse>>('/notifications/batch');
    },
  };
}
