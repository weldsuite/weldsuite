/**
 * WeldChat domain types.
 *
 * Request shapes shared by the WeldChat UI and `hooks/queries/use-weldchat-queries.ts`,
 * which talks to app-api directly via `useAppApiClient()`.
 *
 * This module used to also export a `weldchatWorkerApi` transport bound to the
 * obsolete api-worker. W5b ported that behaviour into app-api's channel services
 * and rewrote the hooks against them, leaving the transport module-private and
 * unreferenced; it was removed in W5c. The types below are the live surface.
 */

// ============================================================================
// Request Types
// ============================================================================

export interface CreateChannelRequest {
  name: string;
  description?: string;
  topic?: string;
  type?: 'public' | 'private';
  icon?: string;
  memberIds?: string[];
}

export interface UpdateChannelRequest {
  name?: string;
  description?: string;
  topic?: string;
  icon?: string;
  voiceCallsEnabled?: boolean;
  videoCallsEnabled?: boolean;
  threadsEnabled?: boolean;
  attachmentsEnabled?: boolean;
  reactionsEnabled?: boolean;
  slowModeSeconds?: number;
}

export interface SendMessageRequest {
  content: string;
  htmlContent?: string;
  type?: 'message' | 'system';
  parentId?: string;
  attachments?: Array<{
    id: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    url: string;
    thumbnailUrl?: string;
    // Clip-specific fields (optional)
    clipType?: 'audio' | 'video' | 'screen';
    durationSeconds?: number;
    transcript?: { status: 'pending' | 'processing' | 'completed' | 'failed' };
  }>;
  mentions?: string[];
}

export interface CreateDmRequest {
  userIds: string[];
}

export interface SetUserStatusRequest {
  status: 'online' | 'busy' | 'away' | 'dnd' | 'offline';
  statusText?: string;
  statusEmoji?: string;
  expiresAt?: string;
}
