/**
 * WeldChat calls on LiveKit, the Kubernetes editions' video provider
 * (ADR CHAT-008).
 *
 * There the chat-calls API hands out a LiveKit join token. The web platform
 * joins with `@weldsuite/weldmeet-ui/providers/livekit`, a LiveKit room behind
 * the RealtimeKit client surface; this app joins with the same client, so the
 * call host, the ring and the in-call controls keep one code path for both
 * providers. Only the stage that draws the video differs (`LiveKitStage`).
 *
 * `livekit-client` runs on the WebRTC this binary already ships for
 * RealtimeKit, `@cloudflare/react-native-webrtc`, not on `@livekit/react-native`:
 * that SDK needs `@livekit/react-native-webrtc`, another fork of
 * react-native-webrtc with the same native `WebRTCModule` class and module
 * name, and the two can't be linked into one app. Everything here is
 * JavaScript, so it ships as an OTA update.
 *
 * WeldSuite cloud never calls into this file: `livekit-client` and the LiveKit
 * client are required on first use, after `ensureLiveKitGlobals()`.
 */

import { NativeModules, PixelRatio, Platform } from 'react-native';
import { registerGlobals } from '@cloudflare/react-native-webrtc';
import { randomUUID } from 'expo-crypto';
import type { Room, RoomOptions } from 'livekit-client';

/**
 * `initLiveKitMeeting` of `@weldsuite/weldmeet-ui/providers/livekit`, as this
 * app calls it. Written out instead of imported so this app's type-check
 * (TypeScript 5.8, React Native's lib types) doesn't compile the web
 * package's source; `livekit-call.test.ts` runs the real client.
 */
type InitLiveKitMeeting = <Client>(options: {
  url: string;
  token: string;
  defaults?: { audio?: boolean; video?: boolean };
  room?: Room;
}) => Client;

/**
 * The user agent livekit-client sees. RealtimeKit's SDK reports a desktop
 * Chrome one when it loads; webrtc-adapter (bundled in livekit-client, run on
 * import) reads that as Safari and would patch the native RTCPeerConnection
 * with Safari shims. Without "AppleWebKit/" or "Chrome/" in it the adapter
 * stands down, as it does under `@livekit/react-native`.
 */
export const LIVEKIT_USER_AGENT = 'ReactNative';

/**
 * The room this app joins with. One video layer: simulcast on mobile needs the
 * simulcast encoder factory `@livekit/react-native-webrtc` adds, which
 * RealtimeKit's WebRTC hasn't got; and with no video elements to measure,
 * adaptive stream and dynacast would have nothing to go by. A chat call has
 * a few people, so full quality for everyone is fine.
 */
export const LIVEKIT_ROOM_OPTIONS: RoomOptions = {
  adaptiveStream: false,
  dynacast: false,
  audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  publishDefaults: { simulcast: false },
};

let globalsReady = false;

/**
 * What `@livekit/react-native`'s `registerGlobals()` sets up that this app
 * doesn't already have. Expo's runtime supplies URL, TextDecoder,
 * DOMException, ReadableStream and structuredClone; RealtimeKit's SDK the
 * WebRTC globals and `crypto.getRandomValues`. Idempotent.
 */
export function ensureLiveKitGlobals(): void {
  if (globalsReady) return;
  // RTCPeerConnection, MediaStream, navigator.mediaDevices. RealtimeKit's SDK
  // registers them when it loads too; doing it here doesn't rely on that.
  registerGlobals();
  // livekit-client reads the platform from here (iOS encodings, client info).
  (globalThis as { LiveKitReactNativeGlobal?: unknown }).LiveKitReactNativeGlobal = {
    platform: Platform.OS,
    devicePixelRatio: PixelRatio.get(),
  };
  if (globalThis.navigator) {
    Object.defineProperty(globalThis.navigator, 'userAgent', {
      get: () => LIVEKIT_USER_AGENT,
      configurable: true,
    });
  }
  // Data streams and RPC (unused by calls, but nothing should throw).
  const crypto = globalThis.crypto as (Crypto & { randomUUID?: () => string }) | undefined;
  if (crypto && typeof crypto.randomUUID !== 'function') {
    crypto.randomUUID = randomUUID as Crypto['randomUUID'];
  }
  globalsReady = true;
}

/**
 * RealtimeKit's own in-call audio module (`@cloudflare/realtimekit-react-native`,
 * a fork of react-native-incall-manager). Its `start` takes no arguments on
 * either platform; `stop` takes a busy-tone name on iOS and nothing on Android.
 */
interface InCallManagerModule {
  start?: () => void;
  stop?: (busytone?: string) => void;
}

function inCallManager(): InCallManagerModule | undefined {
  return NativeModules.InCallManager as InCallManagerModule | undefined;
}

/** Calls holding the in-call audio session: a call still closing can overlap the next. */
let audioHolds = 0;

/**
 * Route call audio as RealtimeKit does: its SDK starts the in-call audio
 * session (speaker, Bluetooth kept available, screen kept on) with its
 * `InCallManager` native module when a call's media is set up, and this binary
 * has that module on every edition. A missing module (an old binary) just
 * leaves WebRTC's default.
 *
 * Returns the release. The session goes back to the app (media audio, the
 * screen allowed to sleep) when the last call holding it lets go; until then
 * voice messages and other sounds would play at call volume.
 */
export function holdCallAudio(): () => void {
  audioHolds += 1;
  if (audioHolds === 1) {
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
    audioHolds -= 1;
    if (audioHolds > 0) return;
    try {
      // The bridge checks the argument count. RealtimeKit plays no busy tone.
      if (Platform.OS === 'ios') inCallManager()?.stop?.('');
      else inCallManager()?.stop?.();
    } catch {
      // Nothing was started.
    }
  };
}

export interface LiveKitCallOptions {
  /** The LiveKit server (`/config.json`'s `videoUrl`). */
  url: string;
  /** The LiveKit join token from start-and-join, prepare or join. */
  token: string;
  /** What to send once in the room. */
  defaults: { audio: boolean; video: boolean };
}

export interface LiveKitCall<Client> {
  /**
   * The call client, typed as the RealtimeKit client the call host is written
   * against. Not connected yet: the call host calls `join()`, as it does on
   * RealtimeKit.
   */
  meeting: Client;
  /**
   * The call is over, however it ended: leave the room if still in it, then
   * give the phone's audio back. Safe to call more than once.
   */
  end: () => Promise<void>;
}

/** A call on LiveKit, holding the in-call audio session until `end()`. */
export function createLiveKitCall<Client>(options: LiveKitCallOptions): LiveKitCall<Client> {
  ensureLiveKitGlobals();
  // After the globals: livekit-client runs webrtc-adapter when it loads.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded on first use, never on Global
  const { Room } = require('livekit-client') as typeof import('livekit-client');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- imports livekit-client
  const { initLiveKitMeeting } = require('@weldsuite/weldmeet-ui/providers/livekit') as {
    initLiveKitMeeting: InitLiveKitMeeting;
  };
  const meeting = initLiveKitMeeting<Client>({
    url: options.url,
    token: options.token,
    defaults: options.defaults,
    room: new Room(LIVEKIT_ROOM_OPTIONS),
  });
  const releaseAudio = holdCallAudio();
  let ended: Promise<void> | undefined;
  const end = () => {
    ended ??= (async () => {
      try {
        // Waits for a leave already under way. Only then hand the audio
        // back: iOS stops whatever still plays into a session it deactivates.
        await (meeting as unknown as { leave: () => Promise<void> }).leave();
      } catch {
        // Gone already.
      }
      releaseAudio();
    })();
    return ended;
  };
  return { meeting, end };
}
