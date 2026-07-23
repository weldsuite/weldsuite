/**
 * WeldMeet Domain API Factory
 *
 * Typed client for /api/weldmeet/* on core-api. Includes:
 *   - Single-shot `startInstantMeeting` (create + RTK + first join in one call).
 *   - Meeting CRUD (list, get, create, update, delete, cancel, upcoming, joinByCode).
 *   - Session lifecycle (start, join, leave, end, get, getActive, getLatest).
 *   - Recording controls (start, stop, listForSession, listAll).
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  StartInstantMeetingInput,
  StartInstantMeetingResult,
  CreateMeetingInput,
  CreateMeetingResult,
  UpdateMeetingInput,
  UpdateMeetingResult,
  ListMeetingsQuery,
  UpcomingMeetingsQuery,
  CancelMeetingResult,
  Meeting,
  MeetingSession,
  StartSessionResult,
  JoinSessionResult,
  RecordingSummary,
  SessionRecordingsResult,
  StopRecordingResult,
  OkResult,
  HostControlsInput,
  HostControls,
} from '../schemas/weldmeet';

export function createWeldmeetApi(api: ClientApi) {
  return {
    // ====== Single-shot start-instant ======
    startInstantMeeting(
      input: StartInstantMeetingInput = {},
    ): Promise<DataResponse<StartInstantMeetingResult>> {
      return api.post<DataResponse<StartInstantMeetingResult>>(
        '/weldmeet/sessions/start-instant',
        input,
      );
    },

    // ====== Meetings ======
    listMeetings(params: ListMeetingsQuery = { page: 1, pageSize: 20 }): Promise<ListResponse<Meeting>> {
      return api.get<ListResponse<Meeting>>(
        `/weldmeet/meetings${buildQueryString(params as Record<string, unknown>)}`,
      );
    },

    listRecordings(): Promise<DataResponse<RecordingSummary[]>> {
      return api.get<DataResponse<RecordingSummary[]>>('/weldmeet/meetings/recordings');
    },

    listUpcoming(
      params: UpcomingMeetingsQuery = { days: 7, limit: 20 },
    ): Promise<DataResponse<Meeting[]>> {
      return api.get<DataResponse<Meeting[]>>(
        `/weldmeet/meetings/upcoming${buildQueryString(params as Record<string, unknown>)}`,
      );
    },

    getMeetingByJoinCode(joinCode: string): Promise<DataResponse<Meeting>> {
      return api.get<DataResponse<Meeting>>(`/weldmeet/meetings/join/${joinCode}`);
    },

    getMeeting(id: string): Promise<DataResponse<Meeting>> {
      return api.get<DataResponse<Meeting>>(`/weldmeet/meetings/${id}`);
    },

    createMeeting(input: CreateMeetingInput): Promise<DataResponse<CreateMeetingResult>> {
      return api.post<DataResponse<CreateMeetingResult>>('/weldmeet/meetings', input);
    },

    updateMeeting(id: string, input: UpdateMeetingInput): Promise<DataResponse<UpdateMeetingResult>> {
      return api.put<DataResponse<UpdateMeetingResult>>(`/weldmeet/meetings/${id}`, input);
    },

    deleteMeeting(id: string): Promise<void> {
      return api.delete<void>(`/weldmeet/meetings/${id}`);
    },

    cancelMeeting(id: string, sendNotification = false): Promise<DataResponse<CancelMeetingResult>> {
      const qs = sendNotification ? '?sendNotification=true' : '';
      return api.patch<DataResponse<CancelMeetingResult>>(`/weldmeet/meetings/${id}/cancel${qs}`, {});
    },

    updateHostControls(id: string, input: HostControlsInput): Promise<DataResponse<HostControls>> {
      return api.patch<DataResponse<HostControls>>(`/weldmeet/meetings/${id}/host-controls`, input);
    },

    // ====== Sessions ======
    startSession(meetingId: string, joinInline = false): Promise<DataResponse<StartSessionResult>> {
      const qs = joinInline ? '?join=true' : '';
      return api.post<DataResponse<StartSessionResult>>(
        `/weldmeet/meetings/${meetingId}/sessions/start${qs}`,
        {},
      );
    },

    joinSession(meetingId: string, sessionId: string): Promise<DataResponse<JoinSessionResult>> {
      return api.post<DataResponse<JoinSessionResult>>(
        `/weldmeet/meetings/${meetingId}/sessions/${sessionId}/join`,
        {},
      );
    },

    leaveSession(meetingId: string, sessionId: string): Promise<DataResponse<OkResult>> {
      return api.post<DataResponse<OkResult>>(
        `/weldmeet/meetings/${meetingId}/sessions/${sessionId}/leave`,
        {},
      );
    },

    endSession(meetingId: string, sessionId: string): Promise<DataResponse<OkResult>> {
      return api.post<DataResponse<OkResult>>(
        `/weldmeet/meetings/${meetingId}/sessions/${sessionId}/end`,
        {},
      );
    },

    getSession(meetingId: string, sessionId: string): Promise<DataResponse<MeetingSession>> {
      return api.get<DataResponse<MeetingSession>>(
        `/weldmeet/meetings/${meetingId}/sessions/${sessionId}`,
      );
    },

    getActiveSession(meetingId: string): Promise<DataResponse<MeetingSession | null>> {
      return api.get<DataResponse<MeetingSession | null>>(
        `/weldmeet/meetings/${meetingId}/sessions/active`,
      );
    },

    getLatestSession(meetingId: string): Promise<DataResponse<MeetingSession | null>> {
      return api.get<DataResponse<MeetingSession | null>>(
        `/weldmeet/meetings/${meetingId}/sessions/latest`,
      );
    },

    // ====== Session-level recordings ======
    startRecording(meetingId: string, sessionId: string): Promise<DataResponse<OkResult>> {
      return api.post<DataResponse<OkResult>>(
        `/weldmeet/meetings/${meetingId}/sessions/${sessionId}/recording/start`,
        {},
      );
    },

    stopRecording(meetingId: string, sessionId: string): Promise<DataResponse<StopRecordingResult>> {
      return api.post<DataResponse<StopRecordingResult>>(
        `/weldmeet/meetings/${meetingId}/sessions/${sessionId}/recording/stop`,
        {},
      );
    },

    listSessionRecordings(
      meetingId: string,
      sessionId: string,
    ): Promise<DataResponse<SessionRecordingsResult>> {
      return api.get<DataResponse<SessionRecordingsResult>>(
        `/weldmeet/meetings/${meetingId}/sessions/${sessionId}/recordings`,
      );
    },
  };
}
