/**
 * The phone's call audio during a WeldChat call, on either video provider
 * (ADR CHAT-008).
 *
 * RealtimeKit's `InCallManager` native module (its own fork of
 * react-native-incall-manager, linked into every build of this app) switches
 * the phone to call audio: on iOS the PlayAndRecord/VideoChat audio session
 * with the screen kept on, on Android communication mode, audio focus, a wake
 * lock and the proximity sensor. Its `start` does nothing while it is started;
 * `stop` puts the audio back the way `start` found it, and the next `start`
 * sets it up again.
 *
 * RealtimeKit's SDK starts it when it sets up a call's media and never stops
 * it; on LiveKit this app starts it. Either way each call holds it, and the
 * last call to let go stops it, so a call still closing can't take the audio
 * from the next one.
 */

import { NativeModules, Platform } from 'react-native';

/**
 * RealtimeKit's in-call audio module. Its `start` takes no arguments on either
 * platform; `stop` takes a busy-tone name on iOS and nothing on Android.
 */
interface InCallManagerModule {
  start?: () => void;
  stop?: (busytone?: string) => void;
}

function inCallManager(): InCallManagerModule | undefined {
  return NativeModules.InCallManager as InCallManagerModule | undefined;
}

/** Calls holding the call audio: a call still closing can overlap the next. */
let holds = 0;

export interface CallAudioHoldOptions {
  /**
   * Start the call audio when no other call holds it. Off on RealtimeKit,
   * whose SDK starts it itself while it sets up the call's media.
   */
  start?: boolean;
}

/**
 * Hold the phone's call audio for a call, routed as RealtimeKit routes it
 * (speaker, Bluetooth kept available, screen kept on). A missing module (an
 * old binary) just leaves WebRTC's default.
 *
 * Returns the release, for once the call has left its room. When the last call
 * holding the audio lets go it goes back to the app (media audio, the screen
 * allowed to sleep); until then voice messages and other sounds play at call
 * volume.
 */
export function holdCallAudio({ start = true }: CallAudioHoldOptions = {}): () => void {
  holds += 1;
  if (start && holds === 1) {
    try {
      inCallManager()?.start?.();
    } catch {
      // WebRTC's default audio session then.
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    if (holds > 0) return;
    try {
      // The bridge checks the argument count. RealtimeKit plays no busy tone.
      if (Platform.OS === 'ios') inCallManager()?.stop?.('');
      else inCallManager()?.stop?.();
    } catch {
      // Nothing was started.
    }
  };
}
