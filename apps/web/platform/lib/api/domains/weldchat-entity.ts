/**
 * WeldChat entity-linked channel domain API.
 *
 * Thin wrappers around app-api's /api/chat-entity-channels/* routes. Use this
 * to attach chat to any business object (task, ticket, deal, …) — the server
 * lazily creates the channel on the first message.
 */

import { appApi } from '../app-api-browser-client';

export interface SendEntityMessageRequest {
  content: string;
  htmlContent?: string;
  parentId?: string;
  mentions?: string[];
  mentionsEveryone?: boolean;
  attachments?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
}

export interface EntityChannel {
  id: string;
  name: string;
  slug: string;
  type: 'entity';
  entityType: string;
  entityId: string;
  entityDisplayName: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  messageCount: number;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * app-api single-resource envelope. The legacy api-worker also carried a
 * `success: boolean` alongside `data`; app-api dropped it. Nothing here ever
 * read that flag (errors arrive as a thrown `ApiError`), so the exported method
 * signatures below are unchanged.
 */
interface Envelope<T> {
  data: T;
}

export const weldchatEntityApi = {
  /** Returns the channel linked to the entity, or null if it doesn't exist yet. */
  getEntityChannel: async (entityType: string, entityId: string): Promise<EntityChannel | null> => {
    const res = await appApi.get<Envelope<EntityChannel | null>>(
      `/chat-entity-channels/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}/channel`,
    );
    return res?.data ?? null;
  },

  /** Post a message; creates the channel on first send. */
  sendEntityMessage: async (
    entityType: string,
    entityId: string,
    data: SendEntityMessageRequest,
  ): Promise<{ channel: EntityChannel; message: unknown; createdChannel: boolean }> => {
    const res = await appApi.post<Envelope<{
      channel: EntityChannel;
      message: unknown;
      createdChannel: boolean;
    }>>(
      `/chat-entity-channels/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}/messages`,
      data,
    );
    return res.data;
  },

  /** List every channel for an entity type the caller has access to. */
  listEntityChannels: async (entityType: string): Promise<EntityChannel[]> => {
    const res = await appApi.get<Envelope<EntityChannel[]>>(
      `/chat-entity-channels/${encodeURIComponent(entityType)}`,
    );
    return res?.data ?? [];
  },

  /** Provider-specific entity details for the right-side panel. */
  getEntityDetail: async (
    entityType: string,
    entityId: string,
  ): Promise<Record<string, unknown> | null> => {
    const res = await appApi.get<Envelope<Record<string, unknown> | null>>(
      `/chat-entity-channels/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}/detail`,
    );
    return res?.data ?? null;
  },
};
