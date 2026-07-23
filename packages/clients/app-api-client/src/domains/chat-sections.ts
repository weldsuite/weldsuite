/**
 * App-API chat-sections domain client — flat `/api/chat-sections/*`.
 *
 * Backed by `chatSections`. Mirrors apps/workers/app-api/src/routes/chat-sections/index.ts.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';

export interface ChatSectionRow {
  id: string;
  name: string;
  userId: string | null;
  position: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListChatSectionsQuery {
  search?: string;
  cursor?: string;
  limit?: number;
}

export interface CreateChatSectionInput {
  name: string;
  userId?: string | null;
  position?: number;
  metadata?: unknown;
  [key: string]: unknown;
}

export type UpdateChatSectionInput = Partial<CreateChatSectionInput>;

export function createChatSectionsApi(api: ClientApi) {
  return {
    list(params: ListChatSectionsQuery = {}): Promise<ListResponse<ChatSectionRow>> {
      return api.get<ListResponse<ChatSectionRow>>(
        `/chat-sections${buildQueryString(params as Record<string, unknown>)}`,
      );
    },

    get(id: string): Promise<DataResponse<ChatSectionRow>> {
      return api.get<DataResponse<ChatSectionRow>>(`/chat-sections/${id}`);
    },

    create(data: CreateChatSectionInput): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>('/chat-sections', data);
    },

    update(id: string, data: UpdateChatSectionInput): Promise<DataResponse<{ id: string }>> {
      return api.patch<DataResponse<{ id: string }>>(`/chat-sections/${id}`, data);
    },

    delete(id: string): Promise<void> {
      return api.delete<void>(`/chat-sections/${id}`);
    },
  };
}
