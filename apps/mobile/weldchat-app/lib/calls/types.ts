/**
 * The call client the call host and the in-call room are written against:
 * RealtimeKit's client surface (`meeting.self`, `meeting.participants.joined`,
 * `join()`, `leave()` and their events). On LiveKit the client is
 * `@weldsuite/weldmeet-ui/providers/livekit`'s, which answers to the same
 * surface (see `lib/calls/livekit.ts`).
 */

import type { useRealtimeKitClient } from '@cloudflare/realtimekit-react-native';

export type MeetingClient = NonNullable<ReturnType<typeof useRealtimeKitClient>[0]>;

/** What the call host hands the client to set up a call (`initMeeting`). */
export interface CallInitOptions {
  /** The join token the chat-calls API handed out (RealtimeKit's or LiveKit's). */
  authToken: string;
  /** What to send once in the room. */
  defaults: { audio: boolean; video: boolean };
}
