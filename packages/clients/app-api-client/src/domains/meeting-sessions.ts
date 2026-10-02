/**
 * App-API meeting-sessions domain client — flat `/api/meeting-sessions`
 * (served by meet-api).
 */

import type { ClientApi, DataResponse } from '../types';
import type {
  RemoveMeetingSessionParticipantInput,
  RemoveMeetingSessionParticipantResult,
} from '../schemas/meeting-sessions';

export function createMeetingSessionsApi(api: ClientApi) {
  return {
    /**
     * Host "Remove from call": records the removal on the session (a removed
     * guest cannot rejoin it) and disconnects the participant.
     */
    removeParticipant(
      sessionId: string,
      data: RemoveMeetingSessionParticipantInput,
    ): Promise<DataResponse<RemoveMeetingSessionParticipantResult>> {
      return api.post<DataResponse<RemoveMeetingSessionParticipantResult>>(
        `/meeting-sessions/${encodeURIComponent(sessionId)}/participants/remove`,
        data,
      );
    },
  };
}
