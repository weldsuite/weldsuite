/**
 * Which video provider WeldChat calls join with (ADRs CHAT-008, MEET-007).
 *
 * The chat-calls API mints the join token for its deployment's provider:
 * Cloudflare RealtimeKit on WeldSuite cloud, a self-hosted LiveKit server on
 * the Kubernetes editions (EU, self-hosted). The app learns which from the
 * server it runs against: Global's runtime names none (RealtimeKit, as
 * before), a Kubernetes server's `/config.json` says `videoProvider:
 * "livekit"` and the server's `videoUrl`. Fixed for the JS lifetime, like the
 * rest of the runtime (ADR MOB-006).
 */

import {
  videoJoinTarget,
  type VideoJoinTarget,
} from '@weldsuite/weldmeet-ui/providers/video-provider';
import type { MobileRuntime } from '@weldsuite/mobile-platform/runtime';

export type CallJoinTarget = VideoJoinTarget;

/**
 * Where calls on this server join. Null when the server says LiveKit but
 * gives no usable server URL: its tokens are LiveKit's, so RealtimeKit could
 * never connect, and the call can't be joined at all.
 */
export function callJoinTarget(
  runtime: Pick<MobileRuntime, 'videoProvider' | 'videoUrl'>,
): CallJoinTarget | null {
  try {
    return videoJoinTarget(runtime.videoProvider, runtime.videoUrl);
  } catch {
    return null;
  }
}
