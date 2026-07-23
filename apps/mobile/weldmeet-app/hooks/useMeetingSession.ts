import { useCallback, useEffect, useState } from 'react';
import { useWeldmeetApi } from '@/services/app-api';
import type { MeetingSession } from '@weldsuite/core-api-client/schemas/weldmeet';

/**
 * Joinable session shape: either a freshly started session (start with
 * ?join=true returns authToken inline) or a join-into-existing session.
 * Both paths surface a `sessionId`, `cfAppId` (RTK meeting id) and an
 * `authToken` ready for the RealtimeKit RN client to consume.
 */
export interface JoinedSession {
  id: string;
  cfAppId: string | null;
  authToken: string;
}

interface State {
  session: JoinedSession | null;
  loading: boolean;
  error: string | null;
  /** Leave the SFU session. Caller is still responsible for navigating away. */
  leave: () => Promise<void>;
}

function toMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string') return err;
  return fallback;
}

export function useMeetingSession(meetingId: string | undefined): State {
  const { weldmeet } = useWeldmeetApi();
  const [session, setSession] = useState<JoinedSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!meetingId) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);

      try {
        // 1. If a session is already running, join it.
        const active = await weldmeet.getActiveSession(meetingId);
        if (cancelled) return;
        const activeSession = active.data;

        if (activeSession) {
          const joined = await weldmeet.joinSession(meetingId, activeSession.id);
          if (cancelled) return;
          setSession({
            id: joined.data.sessionId,
            cfAppId: activeSession.cfAppId,
            authToken: joined.data.authToken,
          });
          setLoading(false);
          return;
        }

        // 2. No active session — start a fresh one and join inline.
        const started = await weldmeet.startSession(meetingId, true);
        if (cancelled) return;
        const data = started.data;
        if (!data.authToken) {
          throw new Error('Server did not return an auth token for the new session.');
        }
        setSession({
          id: data.sessionId,
          cfAppId: data.rtkMeetingId,
          authToken: data.authToken,
        });
      } catch (err) {
        if (cancelled) return;
        setError(toMessage(err, 'Could not start the meeting'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [meetingId, weldmeet]);

  const leave = useCallback(async () => {
    if (!meetingId || !session) return;
    try {
      await weldmeet.leaveSession(meetingId, session.id);
    } catch (err) {
      console.warn('[weldmeet] leaveSession failed:', err);
    }
  }, [meetingId, session, weldmeet]);

  return { session, loading, error, leave };
}

// Re-export for convenience.
export type { MeetingSession };
