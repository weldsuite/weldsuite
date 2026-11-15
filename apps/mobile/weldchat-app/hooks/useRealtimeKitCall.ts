/**
 * `useRealtimeKitClient` with what RealtimeKit's SDK leaves out: when the call
 * ends, leave its meeting if nobody did and give the phone's call audio back
 * (`lib/calls/realtimekit.ts`). `useLiveKitClient` is the LiveKit side.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useRealtimeKitClient } from '@cloudflare/realtimekit-react-native';
import { startRealtimeKitCall, type RealtimeKitCall } from '@/lib/calls/realtimekit';
import type { CallInitOptions, MeetingClient } from '@/lib/calls/types';

export function useRealtimeKitCall(): [
  MeetingClient | undefined,
  (options: CallInitOptions) => Promise<MeetingClient | undefined>,
] {
  const [meeting, initMeeting] = useRealtimeKitClient();
  const callsRef = useRef<RealtimeKitCall<MeetingClient>[]>([]);
  const init = useCallback(
    (options: CallInitOptions) => {
      const call = startRealtimeKitCall<MeetingClient>(() => initMeeting(options));
      callsRef.current = [...callsRef.current, call];
      return call.meeting;
    },
    [initMeeting],
  );
  // The call host unmounts when its call ends, however it ended (hung up,
  // ended by the other side or the server, a join that failed, a newer call).
  useEffect(
    () => () => {
      for (const call of callsRef.current) void call.end();
    },
    [],
  );
  return [meeting, init];
}
