import { isLiveKit } from '@/lib/video-provider';

/**
 * Warm the chunk of the SDK this deployment joins calls with, so a call
 * starts without a lazy-load delay. The Kubernetes editions (the runtime
 * config says LiveKit; it is read before the app boots) join with the LiveKit
 * client; Global loads RealtimeKit exactly as before and never fetches
 * livekit-client. A failed load is ignored: the call loads it again.
 */
export function prefetchCallSdk(): Promise<unknown> {
  const chunk: Promise<unknown> = isLiveKit()
    ? import('@weldsuite/weldmeet-ui/providers/livekit')
    : import('@cloudflare/realtimekit');
  return chunk.catch(() => undefined);
}
