/**
 * App-API chat-dm domain client — flat `/api/chat-dm/*`.
 *
 * Backed by `chatChannels` (type = 'dm') + `chatChannelMembers`. Mirrors
 * apps/workers/app-api/src/routes/chat-dm/index.ts.
 */

import type { ClientApi, DataResponse } from '../types';
import type { ChannelRow } from './channels';

export interface DmMember {
  userId: string;
  role?: string | null;
  lastReadAt?: string | null;
  lastReadMessageId?: string | null;
  name: string | null;
  email: string | null;
  picture: string | null;
}

export interface DmChannel extends ChannelRow {
  members: DmMember[];
  otherMembers?: DmMember[];
  lastReadAt?: string | null;
  lastReadMessageId?: string | null;
}

export interface CreateDmInput {
  userIds: string[];
}

export interface PinDmInput {
  isPinned: boolean;
}

export function createChatDmApi(api: ClientApi) {
  return {
    /** List the caller's DM channels. */
    list(): Promise<DataResponse<DmChannel[]>> {
      return api.get<DataResponse<DmChannel[]>>('/chat-dm');
    },

    /** Create-or-get a DM with a set of users. */
    create(data: CreateDmInput): Promise<DataResponse<DmChannel>> {
      return api.post<DataResponse<DmChannel>>('/chat-dm', data);
    },

    /** Get-or-create the DM with a specific target user. */
    getByTarget(targetUserId: string): Promise<DataResponse<DmChannel>> {
      return api.get<DataResponse<DmChannel>>(`/chat-dm/${targetUserId}`);
    },

    archive(channelId: string): Promise<DataResponse<{ id: string; isArchived: boolean }>> {
      return api.patch<DataResponse<{ id: string; isArchived: boolean }>>(
        `/chat-dm/${channelId}/archive`,
        {},
      );
    },

    unarchive(channelId: string): Promise<DataResponse<{ id: string; isArchived: boolean }>> {
      return api.patch<DataResponse<{ id: string; isArchived: boolean }>>(
        `/chat-dm/${channelId}/unarchive`,
        {},
      );
    },

    pin(
      channelId: string,
      data: PinDmInput,
    ): Promise<DataResponse<{ id: string; isPinned: boolean }>> {
      return api.patch<DataResponse<{ id: string; isPinned: boolean }>>(
        `/chat-dm/${channelId}/pin`,
        data,
      );
    },

    /** Leave the DM (removes the caller's membership row). */
    delete(channelId: string): Promise<void> {
      return api.delete<void>(`/chat-dm/${channelId}`);
    },
  };
}
