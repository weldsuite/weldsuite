/**
 * `useRealtimeKitClient`'s counterpart on LiveKit: the client (once set up)
 * and the function that sets it up from a join token.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createLiveKitCall } from '@/lib/calls/livekit';
import type { CallInitOptions, MeetingClient } from '@/lib/calls/types';

export function useLiveKitClient(
  url: string,
): [MeetingClient | undefined, (options: CallInitOptions) => Promise<MeetingClient>] {
  const [meeting, setMeeting] = useState<MeetingClient>();
  const endRef = useRef<(() => Promise<void>) | null>(null);
  const initMeeting = useCallback(
    async ({ authToken, defaults }: CallInitOptions) => {
      void endRef.current?.();
      const call = createLiveKitCall<MeetingClient>({ url, token: authToken, defaults });
      endRef.current = call.end;
      setMeeting(call.meeting);
      return call.meeting;
    },
    [url],
  );
  // The call host unmounts when its call ends, however it ended (hung up,
  // ended by the other side, a join that failed): give the audio back.
  useEffect(
    () => () => {
      void endRef.current?.();
    },
    [],
  );
  return [meeting, initMeeting];
}
