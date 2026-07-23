/**
 * App-API chat-search domain client — flat `/api/chat-search/*`.
 *
 * Full-text search across chat messages the caller can see. Mirrors
 * apps/workers/app-api/src/routes/chat-search/index.ts.
 */

import type { ClientApi, DataResponse } from '../types';
import { buildQueryString } from '../types';

export interface ChatSearchQuery {
  q: string;
  channelId?: string;
  authorId?: string;
  /** ISO datetime — only messages on/after this instant. */
  after?: string;
  /** ISO datetime — only messages on/before this instant. */
  before?: string;
  limit?: number;
}

export interface ChatSearchResult {
  id: string;
  channelId: string;
  authorId: string | null;
  authorName: string | null;
  authorAvatar: string | null;
  content: string | null;
  htmlContent: string | null;
  type: string | null;
  parentId: string | null;
  isPinned: boolean | null;
  hasAttachments: boolean | null;
  attachments: unknown;
  reactions: unknown;
  createdAt: string;
  channel: { name: string; slug: string; type: string } | null;
}

export interface ChatSearchResponse {
  messages: ChatSearchResult[];
  total: number;
}

export function createChatSearchApi(api: ClientApi) {
  return {
    search(params: ChatSearchQuery): Promise<DataResponse<ChatSearchResponse>> {
      return api.get<DataResponse<ChatSearchResponse>>(
        `/chat-search${buildQueryString(params as unknown as Record<string, unknown>)}`,
      );
    },
  };
}
