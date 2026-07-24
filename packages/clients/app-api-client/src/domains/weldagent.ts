/**
 * App-API WeldAgent domain client — flat `/api/weldagent/*`.
 *
 * Backs the personal AI assistant's conversations, messages, settings, and
 * @-mention search on both the platform SPA and mobile. The interactive chat
 * stream (`/chat`) is NOT part of this client — the legacy api-worker
 * streaming endpoint is disabled post-AI-teardown and nothing fetches it.
 *
 * Responses keep the legacy `{ data }` / `{ data: [] }` envelopes (no cursor
 * pagination), matching the wire format the route returns.
 */

import type { ClientApi, DataResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CreateConversationInput,
  UpdateConversationInput,
  SaveMessageInput,
  WeldAgentSettingsInput,
  AutoTitleInput,
  ConversationSummary,
  WeldAgentMessageRow,
  WeldAgentSettings,
  MentionSearchResult,
  AutoTitleResult,
} from '../schemas/weldagent';

export interface MentionSearchQuery {
  query: string;
  type?: string;
  limit?: number;
}

export function createWeldAgentApi(api: ClientApi) {
  return {
    // --- Conversations ---
    listConversations(limit = 50): Promise<DataResponse<ConversationSummary[]>> {
      return api.get<DataResponse<ConversationSummary[]>>(
        `/weldagent/conversations${buildQueryString({ limit })}`,
      );
    },

    createConversation(
      data: CreateConversationInput,
    ): Promise<DataResponse<ConversationSummary>> {
      return api.post<DataResponse<ConversationSummary>>('/weldagent/conversations', data);
    },

    updateConversation(
      conversationId: string,
      data: UpdateConversationInput,
    ): Promise<DataResponse<ConversationSummary>> {
      return api.patch<DataResponse<ConversationSummary>>(
        `/weldagent/conversations/${conversationId}`,
        data,
      );
    },

    deleteConversation(conversationId: string): Promise<void> {
      return api.delete<void>(`/weldagent/conversations/${conversationId}`);
    },

    autoTitleConversation(
      conversationId: string,
      data: AutoTitleInput,
    ): Promise<DataResponse<AutoTitleResult>> {
      return api.post<DataResponse<AutoTitleResult>>(
        `/weldagent/conversations/${conversationId}/auto-title`,
        data,
      );
    },

    // --- Messages ---
    listMessages(
      conversationId: string,
      params: { limit?: number; offset?: number } = {},
    ): Promise<DataResponse<WeldAgentMessageRow[]>> {
      return api.get<DataResponse<WeldAgentMessageRow[]>>(
        `/weldagent/conversations/${conversationId}/messages${buildQueryString(params)}`,
      );
    },

    saveMessage(
      conversationId: string,
      data: SaveMessageInput,
    ): Promise<DataResponse<WeldAgentMessageRow>> {
      return api.post<DataResponse<WeldAgentMessageRow>>(
        `/weldagent/conversations/${conversationId}/messages`,
        data,
      );
    },

    // --- Settings ---
    getSettings(): Promise<DataResponse<WeldAgentSettings>> {
      return api.get<DataResponse<WeldAgentSettings>>('/weldagent/settings');
    },

    saveSettings(data: WeldAgentSettingsInput): Promise<DataResponse<WeldAgentSettings>> {
      return api.put<DataResponse<WeldAgentSettings>>('/weldagent/settings', data);
    },

    // --- Mentions ---
    searchMentions(params: MentionSearchQuery): Promise<DataResponse<MentionSearchResult[]>> {
      return api.get<DataResponse<MentionSearchResult[]>>(
        `/weldagent/mentions/search${buildQueryString({ ...params })}`,
      );
    },
  };
}

export type WeldAgentApi = ReturnType<typeof createWeldAgentApi>;
