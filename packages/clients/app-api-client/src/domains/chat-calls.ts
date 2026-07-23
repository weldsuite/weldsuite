/**
 * App-API chat-calls domain client — flat `/api/chat-calls/*`.
 *
 * Voice/video call lifecycle via Cloudflare RealtimeKit. Mirrors
 * apps/workers/app-api/src/routes/chat-calls/index.ts.
 */

import type { ClientApi, DataResponse } from '../types';

export type ChatCallType = 'voice' | 'video';
export type ChatCallStatus = 'ringing' | 'active' | 'ended' | 'declined' | 'missed';

export interface ChatCallParticipant {
  userId: string;
  userName: string;
  userAvatar?: string;
  joinedAt: string;
  leftAt?: string;
  cfSessionId: string;
  hasAudio: boolean;
  hasVideo: boolean;
  hasScreenShare: boolean;
}

export interface ChatCallRow {
  id: string;
  channelId: string;
  callType: ChatCallType;
  status: ChatCallStatus;
  cfAppId: string | null;
  initiatorId: string;
  initiatorName: string;
  participants: ChatCallParticipant[] | null;
  maxParticipants: number | null;
  startMessageId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StartCallInput {
  channelId: string;
  callType?: ChatCallType;
}

export interface StartCallResponse {
  callId: string;
  status: ChatCallStatus;
  meetingId: string;
}

export interface StartAndJoinResponse {
  callId: string;
  authToken: string;
  participants: ChatCallParticipant[];
  /**
   * The call's type. When start-and-join joins an already-active call, this is
   * the EXISTING call's type (which may differ from the requested one), so the
   * client should prefer this over the requested callType.
   */
  callType?: ChatCallType;
}

export interface JoinCallResponse {
  callId: string;
  authToken: string;
  participants: ChatCallParticipant[];
}

export interface ActiveCallSummary {
  channelId: string;
  callId: string;
  callType: ChatCallType;
  status: ChatCallStatus;
  participantCount: number;
}

export function createChatCallsApi(api: ClientApi) {
  return {
    /** Start a call in a channel (ringing). */
    start(data: StartCallInput): Promise<DataResponse<StartCallResponse>> {
      return api.post<DataResponse<StartCallResponse>>('/chat-calls', data);
    },

    /** Start a call AND join it in one request. */
    startAndJoin(data: StartCallInput): Promise<DataResponse<StartAndJoinResponse>> {
      return api.post<DataResponse<StartAndJoinResponse>>('/chat-calls/start-and-join', data);
    },

    /** Join a call — returns a RealtimeKit auth token. */
    join(callId: string): Promise<DataResponse<JoinCallResponse>> {
      return api.post<DataResponse<JoinCallResponse>>(`/chat-calls/${callId}/join`, {});
    },

    /** Leave a call. */
    leave(callId: string): Promise<DataResponse<{ ok: boolean }>> {
      return api.post<DataResponse<{ ok: boolean }>>(`/chat-calls/${callId}/leave`, {});
    },

    /** End a call. */
    end(callId: string): Promise<DataResponse<{ ok: boolean }>> {
      return api.post<DataResponse<{ ok: boolean }>>(`/chat-calls/${callId}/end`, {});
    },

    /** Decline an incoming 1:1 call. */
    decline(callId: string): Promise<DataResponse<{ ok: boolean }>> {
      return api.post<DataResponse<{ ok: boolean }>>(`/chat-calls/${callId}/decline`, {});
    },

    /** All active calls across the caller's channels. */
    active(): Promise<DataResponse<ActiveCallSummary[]>> {
      return api.get<DataResponse<ActiveCallSummary[]>>('/chat-calls/active');
    },

    /** Active call for a specific channel (or null). */
    activeForChannel(channelId: string): Promise<DataResponse<ChatCallRow | null>> {
      return api.get<DataResponse<ChatCallRow | null>>(`/chat-calls/active/${channelId}`);
    },

    /** Call details by id. */
    get(callId: string): Promise<DataResponse<ChatCallRow>> {
      return api.get<DataResponse<ChatCallRow>>(`/chat-calls/${callId}`);
    },
  };
}
