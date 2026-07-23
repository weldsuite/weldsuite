/**
 * App-API channels domain client — flat `/api/channels/*`.
 *
 * Backed by `chatChannels` + `chatChannelMembers`. Mirrors
 * apps/workers/app-api/src/routes/channels/index.ts.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';

export interface ChannelRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  type: string;
  isPrivate: boolean | null;
  isArchived: boolean | null;
  memberCount: number | null;
  voiceCallsEnabled: boolean | null;
  videoCallsEnabled: boolean | null;
  lastMessageAt: string | null;
  createdBy: string | null;
  // Entity linkage — present only for type='entity' channels attached to a
  // business object (task, project, customer, contact, …).
  entityType: string | null;
  entityId: string | null;
  entityDisplayName: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ChannelMember {
  id: string;
  userId: string;
  memberType?: string | null;
  role: string | null;
  joinedAt: string | null;
  isMuted: boolean | null;
  notificationPreference: string | null;
  lastReadAt?: string | null;
  lastReadMessageId?: string | null;
  name: string | null;
  email: string | null;
  picture: string | null;
  workspaceMemberType?: string | null;
  agentIcon?: string | null;
  agentDescription?: string | null;
}

export interface ChannelWithMembers extends ChannelRow {
  members: ChannelMember[];
}

export interface CreateChannelInput {
  name: string;
  description?: string;
  type?: string;
  slug?: string;
  isPrivate?: boolean;
  metadata?: unknown;
  [key: string]: unknown;
}

export type UpdateChannelInput = Partial<CreateChannelInput>;

export interface ListChannelsQuery {
  type?: string;
  search?: string;
  cursor?: string;
  limit?: number;
}

export interface MarkChannelReadResponse {
  channelId: string;
  lastReadAt: string;
  lastReadMessageId: string | null;
}

export interface UpdateChannelMembershipInput {
  isMuted: boolean;
}

export function createChannelsApi(api: ClientApi) {
  return {
    list(params: ListChannelsQuery = {}): Promise<ListResponse<ChannelRow>> {
      return api.get<ListResponse<ChannelRow>>(
        `/channels${buildQueryString(params as Record<string, unknown>)}`,
      );
    },

    get(id: string): Promise<DataResponse<ChannelWithMembers>> {
      return api.get<DataResponse<ChannelWithMembers>>(`/channels/${id}`);
    },

    create(data: CreateChannelInput): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>('/channels', data);
    },

    update(id: string, data: UpdateChannelInput): Promise<DataResponse<{ id: string }>> {
      return api.patch<DataResponse<{ id: string }>>(`/channels/${id}`, data);
    },

    delete(id: string): Promise<void> {
      return api.delete<void>(`/channels/${id}`);
    },

    members(channelId: string): Promise<DataResponse<ChannelMember[]>> {
      return api.get<DataResponse<ChannelMember[]>>(`/channels/${channelId}/members`);
    },

    markRead(channelId: string): Promise<DataResponse<MarkChannelReadResponse>> {
      return api.post<DataResponse<MarkChannelReadResponse>>(`/channels/${channelId}/read`, {});
    },

    updateMembership(
      channelId: string,
      data: UpdateChannelMembershipInput,
    ): Promise<DataResponse<unknown>> {
      return api.patch<DataResponse<unknown>>(`/channels/${channelId}/me`, data);
    },
  };
}
