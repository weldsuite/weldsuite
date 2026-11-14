/**
 * `useRealtimeKitClient`'s counterpart on LiveKit: the client (once set up)
 * and the function that sets it up from a join token.
 */

import { useCallback, useState } from 'react';
import { createLiveKitCall } from '@/lib/calls/livekit';
import type { CallInitOptions, MeetingClient } from '@/lib/calls/types';

export function useLiveKitClient(
  url: string,
): [MeetingClient | undefined, (options: CallInitOptions) => Promise<MeetingClient>] {
  const [meeting, setMeeting] = useState<MeetingClient>();
  const initMeeting = useCallback(
    async ({ authToken, defaults }: CallInitOptions) => {
      const client = createLiveKitCall<MeetingClient>({ url, token: authToken, defaults });
      setMeeting(client);
      return client;
    },
    [url],
  );
  return [meeting, initMeeting];
}
