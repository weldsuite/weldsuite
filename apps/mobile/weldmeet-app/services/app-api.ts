/**
 * app-api client for WeldMeet mobile.
 *
 * Talks to the unified app-api (`/api`) via the shared
 * `@weldsuite/app-api-client` domain clients plus a local WeldMeet domain
 * wrapper over the flat `/api/meetings` + `/api/meeting-sessions` surface.
 * A module-level token getter is wired from `app/_layout.tsx` using Clerk
 * credentials (see `setAppApiTokenGetter`) — the client re-reads the token on
 * every request, so no rebuild is needed when it refreshes.
 *
 * Domain clients return the app-api envelope: `{ data }` for single items,
 * `{ data, pagination }` for lists, and they THROW on non-2xx (204 → `{}`).
 * Call sites wrap calls in try/catch and read `.data` directly.
 */

import { createClientApi } from '@weldsuite/api-client/client';
import { createWorkspacesApi } from '@weldsuite/app-api-client/domains/workspaces';
import { createDashboardApi } from '@weldsuite/app-api-client/domains/dashboard';
import { createMeApi } from '@weldsuite/app-api-client/domains/me';
import { createPushTokensApi } from '@weldsuite/app-api-client/domains/push-tokens';
import type { ClientApi, DataResponse, ListResponse } from '@weldsuite/app-api-client/types';
import { buildQueryString } from '@weldsuite/app-api-client/types';
// Type-only imports — the weldmeet schemas package is still the canonical
// type source (app-api itself validates against these same schemas).
import type {
  Meeting,
  MeetingSession,
  RecordingSummary,
  CreateMeetingInput,
  ListMeetingsQuery,
  UpcomingMeetingsQuery,
  StartSessionResult,
  JoinSessionResult,
  CancelMeetingResult,
  OkResult,
} from '@weldsuite/core-api-client/schemas/weldmeet';

/** app-api base URL. Defaults to the local wrangler dev port (`apps/workers/app-api`). */
export const APP_API_URL = process.env.EXPO_PUBLIC_APP_API_URL || 'http://localhost:8789';

let tokenGetter: () => Promise<string | null> = async () => null;

/** Wire the Clerk token getter. Called from `app/_layout.tsx`. */
export function setAppApiTokenGetter(fn: (() => Promise<string | null>) | null) {
  tokenGetter = fn ?? (async () => null);
}

const client = createClientApi({
  baseUrl: APP_API_URL,
  getToken: () => tokenGetter(),
});

/**
 * WeldMeet domain client against app-api's flat surface:
 *   GET/POST  /api/meetings/*          (list, upcoming, recordings, join code, create, cancel)
 *   GET/POST  /api/meeting-sessions/*  (active, start, join, leave)
 *
 * Method names and signatures mirror the retired core-api weldmeet domain
 * (`@weldsuite/core-api-client/domains/weldmeet`) so hooks and screens keep
 * working unchanged. Sessions are top-level objects on app-api (scoped via
 * `?meetingId=` / the session id), so the `meetingId` argument on join/leave
 * is kept only for signature parity.
 */
function createWeldmeetAppApi(api: ClientApi) {
  return {
    // ====== Meetings ======
    listMeetings(params: Partial<ListMeetingsQuery> = {}): Promise<ListResponse<Meeting>> {
      // app-api uses cursor pagination; map pageSize → limit (first page only,
      // which is all the app requests today).
      const { status, search, pageSize } = params;
      return api.get<ListResponse<Meeting>>(
        `/meetings${buildQueryString({ status, search, limit: pageSize })}`,
      );
    },

    listUpcoming(params: Partial<UpcomingMeetingsQuery> = {}): Promise<DataResponse<Meeting[]>> {
      return api.get<DataResponse<Meeting[]>>(
        `/meetings/upcoming${buildQueryString(params as Record<string, unknown>)}`,
      );
    },

    listRecordings(): Promise<DataResponse<RecordingSummary[]>> {
      return api.get<DataResponse<RecordingSummary[]>>('/meetings/recordings');
    },

    getMeeting(id: string): Promise<DataResponse<Meeting>> {
      return api.get<DataResponse<Meeting>>(`/meetings/${id}`);
    },

    getMeetingByJoinCode(joinCode: string): Promise<DataResponse<Meeting>> {
      return api.get<DataResponse<Meeting>>(`/meetings/join/${encodeURIComponent(joinCode)}`);
    },

    createMeeting(input: CreateMeetingInput): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>('/meetings', input);
    },

    cancelMeeting(id: string, sendNotification = false): Promise<DataResponse<CancelMeetingResult>> {
      const qs = sendNotification ? '?sendNotification=true' : '';
      return api.patch<DataResponse<CancelMeetingResult>>(`/meetings/${id}/cancel${qs}`, {});
    },

    // ====== Sessions ======
    getActiveSession(meetingId: string): Promise<DataResponse<MeetingSession | null>> {
      return api.get<DataResponse<MeetingSession | null>>(
        `/meeting-sessions/active?meetingId=${encodeURIComponent(meetingId)}`,
      );
    },

    startSession(meetingId: string, joinInline = false): Promise<DataResponse<StartSessionResult>> {
      const qs = joinInline ? '?join=true' : '';
      return api.post<DataResponse<StartSessionResult>>(`/meeting-sessions/start${qs}`, {
        meetingId,
      });
    },

    joinSession(_meetingId: string, sessionId: string): Promise<DataResponse<JoinSessionResult>> {
      return api.post<DataResponse<JoinSessionResult>>(`/meeting-sessions/${sessionId}/join`, {});
    },

    leaveSession(_meetingId: string, sessionId: string): Promise<DataResponse<OkResult>> {
      return api.post<DataResponse<OkResult>>(`/meeting-sessions/${sessionId}/leave`, {});
    },
  };
}

export type WeldmeetAppApi = ReturnType<typeof createWeldmeetAppApi>;

export const appApi = {
  workspaces: createWorkspacesApi(client),
  dashboard: createDashboardApi(client),
  me: createMeApi(client),
  pushTokens: createPushTokensApi(client),
  weldmeet: createWeldmeetAppApi(client),
};

// Stable module-level object so `weldmeet` keeps a constant identity in
// React dependency arrays (the old useCoreApi() memoized for the same reason).
const weldmeetApiBundle: { weldmeet: WeldmeetAppApi } = { weldmeet: appApi.weldmeet };

/**
 * Drop-in replacement for the retired `useCoreApi()` hook from
 * `lib/core-api.ts`. Auth is handled by the module-level token getter, so
 * this simply hands back the stable domain bundle.
 */
export function useWeldmeetApi(): { weldmeet: WeldmeetAppApi } {
  return weldmeetApiBundle;
}

/**
 * Raw client for surfaces without a dedicated domain wrapper yet. Returns the
 * same `{ data }` / `{ data, pagination }` envelopes and throws on non-2xx.
 */
export { client as appApiClient };

export default appApi;
