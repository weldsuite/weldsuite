import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  ActivityItem,
  ListActivityQuery,
  UnreadActivityCount,
} from '../schemas/weldchat-activity';

export function createWeldchatActivityApi(api: ClientApi) {
  return {
    list(params: Partial<ListActivityQuery> = {}): Promise<ListResponse<ActivityItem>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<ActivityItem>>(`/weldchat/activity${query}`);
    },

    markRead(notificationId?: string): Promise<void> {
      return api.post<void>('/weldchat/activity/read', { notificationId });
    },

    getUnreadCount(): Promise<DataResponse<UnreadActivityCount>> {
      return api.get<DataResponse<UnreadActivityCount>>('/weldchat/activity/unread-count');
    },
  };
}
