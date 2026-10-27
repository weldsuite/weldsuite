/**
 * App-API record chats domain client — flat `/api/chat-entity-channels/*`.
 *
 * Record chats are the chats attached to companies, people, tasks, projects,
 * domains, sheets and documents (`chat_channels.type = 'entity'`). Following one = having a
 * membership row. Mirrors
 * apps/workers/chat-api/src/routes/chat-entity-channels/index.ts.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type { ChannelRow } from './channels';
import type {
  ListEntityChannelsQuery,
  RecordChatCallerState,
  RecordChatTypeSummary,
  SendEntityMessageInput,
} from '../schemas/chat-entity-channels';

/** One row of `GET /chat-entity-channels`: the channel plus the caller's own state on it. */
export type RecordChatListItem = ChannelRow &
  RecordChatCallerState & {
    entityType: string;
    entityId: string;
    lastMessagePreview?: string | null;
  };

export interface FollowRecordChatResponse {
  channel: ChannelRow;
  following: true;
  /** The chat did not exist yet; following created it. */
  createdChannel: boolean;
}

/** A chat message as `GET …/comments` returns it (the `chat_messages` row). */
export interface RecordCommentMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  authorAvatar: string | null;
  content: string;
  parentId: string | null;
  isEdited: boolean;
  reactions: Record<string, string[]> | null;
  mentions: string[] | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/** `GET …/comments`: the record's chat (null before its first message) and its comment threads' messages, oldest first. */
export interface RecordComments {
  channel: ChannelRow | null;
  messages: RecordCommentMessage[];
}

export interface SendRecordChatMessageResponse {
  channel: ChannelRow;
  message: { id: string; [key: string]: unknown };
  createdChannel: boolean;
}

function recordPath(entityType: string, entityId: string): string {
  return `/chat-entity-channels/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`;
}

export function createChatEntityChannelsApi(api: ClientApi) {
  return {
    /** Record chats, most recent activity first. `filter` defaults to `following` on the server. */
    list(params: ListEntityChannelsQuery = {}): Promise<ListResponse<RecordChatListItem>> {
      return api.get<ListResponse<RecordChatListItem>>(
        `/chat-entity-channels${buildQueryString({ ...params })}`,
      );
    },

    /** Per record type the caller may read: followed, unread and mention counts. */
    summary(): Promise<DataResponse<RecordChatTypeSummary[]>> {
      return api.get<DataResponse<RecordChatTypeSummary[]>>('/chat-entity-channels/summary');
    },

    /** Follow a record's chat; creates the chat when nobody has written in it yet. */
    follow(entityType: string, entityId: string): Promise<DataResponse<FollowRecordChatResponse>> {
      return api.post<DataResponse<FollowRecordChatResponse>>(`${recordPath(entityType, entityId)}/follow`, {});
    },

    /** Stop following. The chat stays readable on the record. */
    unfollow(entityType: string, entityId: string): Promise<void> {
      return api.delete<void>(`${recordPath(entityType, entityId)}/follow`);
    },

    /** The record's chat, or `null` when nobody has written in it yet. Never creates it. */
    getChannel(entityType: string, entityId: string): Promise<DataResponse<ChannelRow | null>> {
      return api.get<DataResponse<ChannelRow | null>>(`${recordPath(entityType, entityId)}/channel`);
    },

    /** The record's own fields as its type's provider shows them (a task's `projectId`, …), or null. */
    getDetail(entityType: string, entityId: string): Promise<DataResponse<Record<string, unknown> | null>> {
      return api.get<DataResponse<Record<string, unknown> | null>>(`${recordPath(entityType, entityId)}/detail`);
    },

    /**
     * The record's comment threads: the messages of its chat posted with
     * `metadata.anchor`, and every reply in their threads.
     */
    getComments(entityType: string, entityId: string): Promise<DataResponse<RecordComments>> {
      return api.get<DataResponse<RecordComments>>(`${recordPath(entityType, entityId)}/comments`);
    },

    /** Post in a record's chat, creating the chat on the first message. Posting follows it. */
    sendMessage(
      entityType: string,
      entityId: string,
      data: SendEntityMessageInput,
    ): Promise<DataResponse<SendRecordChatMessageResponse>> {
      return api.post<DataResponse<SendRecordChatMessageResponse>>(
        `${recordPath(entityType, entityId)}/messages`,
        data,
      );
    },
  };
}
