/**
 * App-API chat-messages domain client — flat `/api/chat-messages/*`.
 *
 * Backed by `chatMessages`. Mirrors apps/workers/app-api/src/routes/chat-messages/index.ts.
 *
 * NOTE on `upload`: the file upload endpoint is `multipart/form-data`. The
 * shared `ClientApi` exposes a dedicated `postForm` method for multipart
 * bodies, so `upload` builds the `FormData` and POSTs it directly.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';

export interface ChatMessageRow {
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
  pinnedBy: string | null;
  pinnedAt: string | null;
  hasAttachments: boolean | null;
  attachments: unknown;
  reactions: unknown;
  mentions: unknown;
  metadata: Record<string, unknown> | null;
  editedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ListChatMessagesQuery {
  channelId?: string;
  authorId?: string;
  /** When set, returns the replies to this message; otherwise top-level only. */
  parentId?: string;
  cursor?: string;
  limit?: number;
}

export interface CreateChatMessageInput {
  channelId?: string | null;
  authorId?: string | null;
  body?: string;
  parentId?: string | null;
  attachments?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
}

export type UpdateChatMessageInput = Partial<CreateChatMessageInput>;

export interface ChatReactionInput {
  emoji: string;
}

export interface ChatPinInput {
  expiresAt?: string;
  silent?: boolean;
}

/** Result row of the reaction / pin services — message id + denormalised state. */
export interface ChatMessageMutationResult {
  id: string;
  channelId: string;
  reactions?: unknown;
  isPinned?: boolean | null;
  pinnedBy?: string | null;
  pinnedAt?: string | null;
  [key: string]: unknown;
}

export interface UploadChatFileResponse {
  url: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  storagePath?: string;
  thumbnailUrl?: string;
}

export function createChatMessagesApi(api: ClientApi) {
  return {
    list(params: ListChatMessagesQuery = {}): Promise<ListResponse<ChatMessageRow>> {
      return api.get<ListResponse<ChatMessageRow>>(
        `/chat-messages${buildQueryString(params as Record<string, unknown>)}`,
      );
    },

    get(id: string): Promise<DataResponse<ChatMessageRow>> {
      return api.get<DataResponse<ChatMessageRow>>(`/chat-messages/${id}`);
    },

    create(data: CreateChatMessageInput): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>('/chat-messages', data);
    },

    update(id: string, data: UpdateChatMessageInput): Promise<DataResponse<{ id: string }>> {
      return api.patch<DataResponse<{ id: string }>>(`/chat-messages/${id}`, data);
    },

    delete(id: string): Promise<void> {
      return api.delete<void>(`/chat-messages/${id}`);
    },

    addReaction(
      id: string,
      data: ChatReactionInput,
    ): Promise<DataResponse<ChatMessageMutationResult>> {
      return api.post<DataResponse<ChatMessageMutationResult>>(
        `/chat-messages/${id}/reactions`,
        data,
      );
    },

    removeReaction(
      id: string,
      emoji: string,
    ): Promise<DataResponse<ChatMessageMutationResult>> {
      return api.delete<DataResponse<ChatMessageMutationResult>>(
        `/chat-messages/${id}/reactions/${encodeURIComponent(emoji)}`,
      );
    },

    pin(id: string, data: ChatPinInput = {}): Promise<DataResponse<ChatMessageMutationResult>> {
      return api.post<DataResponse<ChatMessageMutationResult>>(`/chat-messages/${id}/pin`, data);
    },

    unpin(id: string): Promise<DataResponse<ChatMessageMutationResult>> {
      return api.delete<DataResponse<ChatMessageMutationResult>>(`/chat-messages/${id}/pin`);
    },

    listPinned(channelId: string): Promise<DataResponse<ChatMessageRow[]>> {
      return api.get<DataResponse<ChatMessageRow[]>>(
        `/chat-messages/pinned${buildQueryString({ channelId })}`,
      );
    },

    /**
     * Upload a chat attachment via `multipart/form-data`. Builds the FormData
     * (`file` + optional `channelId`) and POSTs it through the multipart-capable
     * `postForm` transport. Returns the stored file's URL + metadata.
     */
    upload(file: File, channelId?: string): Promise<DataResponse<UploadChatFileResponse>> {
      const form = buildUploadFormData(file, channelId);
      return api.postForm<DataResponse<UploadChatFileResponse>>('/chat-messages/upload', form);
    },
  };
}

/** Internal helper — builds the multipart body for {@link createChatMessagesApi}'s `upload`. */
function buildUploadFormData(file: File, channelId?: string): FormData {
  const form = new FormData();
  form.append('file', file);
  if (channelId) form.append('channelId', channelId);
  return form;
}
