/**
 * Which video provider this deployment joins WeldMeet rooms with.
 *
 * Global serves no `/config.json` and joins with Cloudflare RealtimeKit,
 * exactly as before. The Kubernetes editions say `videoProvider: "livekit"`
 * and `videoUrl` (the Rust backend's VIDEO_PROVIDER and LIVEKIT_URL); the meet
 * API then hands out LiveKit join tokens, which the call context gives to the
 * LiveKit client in `@weldsuite/weldmeet-ui/providers/livekit` instead of
 * `RealtimeKitClient.init`. Read once at boot, like the rest of the runtime
 * config, so plain functions.
 */

import {
  parseVideoProvider,
  videoJoinTarget,
  type VideoJoinTarget,
  type VideoProvider,
} from '@weldsuite/weldmeet-ui/providers/video-provider';
import { getRuntimeConfig } from '@/lib/runtime-config';

/** The provider this deployment's meet API mints join tokens for. */
export function videoProvider(): VideoProvider {
  return parseVideoProvider(getRuntimeConfig()?.videoProvider);
}

/** Whether meetings run on LiveKit (a Kubernetes edition that says so). */
export function isLiveKit(): boolean {
  return videoProvider() === 'livekit';
}

/**
 * Where a client joins. Throws for LiveKit without a server URL: the token
 * is a LiveKit one, so falling back to RealtimeKit could never connect.
 */
export function videoJoin(): VideoJoinTarget {
  const config = getRuntimeConfig();
  return videoJoinTarget(config?.videoProvider, config?.videoUrl);
}
