/**
 * WeldChat calls on RealtimeKit, WeldSuite cloud's video provider
 * (ADR CHAT-008): giving the phone's audio back when a call ends.
 *
 * RealtimeKit's SDK (`@cloudflare/realtimekit-react-native` 2.0) starts its
 * `InCallManager` while `init` sets up the call's media (`LocalMediaHandler`'s
 * constructor) and nothing in it ever stops it: `leave()` stops the tracks,
 * not the call audio. So after a call the app stayed in call audio: on iOS the
 * screen never slept, on Android the wake lock and the proximity sensor stayed
 * on, and voice messages played at call volume or from the earpiece.
 *
 * A call here holds the call audio (`./call-audio`, shared with LiveKit) from
 * before `init` and gives it back once its meeting has left.
 */

import { holdCallAudio } from './call-audio';

/** What of RealtimeKit's client ending a call needs. */
export interface RealtimeKitLeavable {
  self?: { roomState?: string };
  leave(): Promise<unknown>;
}

export interface RealtimeKitCall<Client> {
  /**
   * What `init` resolves with: the client, or `undefined` when RealtimeKit's
   * hook was busy setting one up already.
   */
  meeting: Promise<Client | undefined>;
  /**
   * The call is over, however it ended: wait for a set-up still under way,
   * leave the meeting unless the call host already did, then give the phone's
   * audio back. Safe to call more than once.
   */
  end: () => Promise<void>;
}

/**
 * Set a RealtimeKit call up with `init` (`useRealtimeKitClient`'s), holding the
 * call audio until `end()`.
 */
export function startRealtimeKitCall<Client extends RealtimeKitLeavable>(
  init: () => Promise<Client | undefined>,
): RealtimeKitCall<Client> {
  // Before `init`, where the SDK starts the call audio: a call still leaving
  // then can't stop it under this one. The SDK does the start.
  const releaseAudio = holdCallAudio({ start: false });
  const meeting = (async () => init())();
  let ended: Promise<void> | undefined;
  const end = () => {
    ended ??= (async () => {
      let client: Client | undefined;
      try {
        client = await meeting;
      } catch {
        // Set-up failed, perhaps after the SDK started the call audio.
      }
      // A hang-up has left already. Leaving again isn't a no-op on
      // RealtimeKit: it runs the leave again and tells the server twice.
      if (client && client.self?.roomState !== 'left') {
        try {
          await client.leave();
        } catch {
          // Gone already.
        }
      }
      // Only now: iOS stops whatever still plays into a session it deactivates.
      releaseAudio();
    })();
    return ended;
  };
  return { meeting, end };
}
