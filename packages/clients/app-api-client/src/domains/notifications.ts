/**
 * App-API notifications domain client — flat `/api/notifications/*`.
 *
 * Backed by `notifications`. Mirrors apps/workers/app-api/src/routes/notifications/index.ts.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';

export interface NotificationRow {
  id: string;
  userId: string | null;
  title: string | null;
  body: string | null;
  category: string | null;
  notificationType: string;
  actionUrl: string | null;
  entityType: string | null;
  entityId: string | null;
  icon: string | null;
  severity: string;
  /** Extra payload data (jsonb `data` column). */
  data: Record<string, unknown> | null;
  isRead: boolean | null;
  readAt: string | null;
  actorType: string | null;
  actorId: string | null;
  /** Resolved from the actor's workspace member record (user actors only). */
  actorName: string | null;
  /** Resolved avatar URL of the actor (user actors only); null when none. */
  actorAvatar: string | null;
  createdAt: string;
  expiresAt: string | null;
  deletedAt: string | null;
}

export interface ListNotificationsQuery {
  userId?: string;
  isRead?: boolean;
  cursor?: string;
  limit?: number;
}

export function createNotificationsApi(api: ClientApi) {
  return {
    list(params: ListNotificationsQuery = {}): Promise<ListResponse<NotificationRow>> {
      return api.get<ListResponse<NotificationRow>>(
        `/notifications${buildQueryString(params as Record<string, unknown>)}`,
      );
    },

    unreadCount(): Promise<DataResponse<{ count: number }>> {
      return api.get<DataResponse<{ count: number }>>('/notifications/unread-count');
    },

    markRead(id: string): Promise<DataResponse<NotificationRow>> {
      return api.post<DataResponse<NotificationRow>>(`/notifications/${id}/read`, {});
    },

    markAllRead(): Promise<DataResponse<{ updated: number }>> {
      return api.post<DataResponse<{ updated: number }>>('/notifications/read-all', {});
    },

    /** DELETE returns 204 No Content. */
    delete(id: string): Promise<void> {
      return api.delete<void>(`/notifications/${id}`);
    },
  };
}
