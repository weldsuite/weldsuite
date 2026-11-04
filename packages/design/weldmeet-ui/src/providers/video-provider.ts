/**
 * Which video provider a deployment joins WeldMeet rooms with.
 *
 * - `realtimekit`: Cloudflare RealtimeKit. Global's provider, and what every
 *   client assumes when nothing says otherwise.
 * - `livekit`: a self-hosted LiveKit server (the Kubernetes editions, EU and
 *   self-hosted). The meet API hands out LiveKit join tokens instead of
 *   RealtimeKit auth tokens, and the client connects to `url`.
 *
 * The platform learns it from `/config.json` (`videoProvider`, `videoUrl`,
 * written by the Rust backend from `VIDEO_PROVIDER`/`LIVEKIT_URL`); the
 * meeting portal from its own join answer. Both then hand the token to the
 * matching client: `RealtimeKitClient.init` as before, or
 * `initLiveKitMeeting` (`providers/livekit`), which answers to the same
 * client surface, so the WeldMeet UI in this package works on either.
 */

export type VideoProvider = 'realtimekit' | 'livekit';

/** Where and how a client joins: RealtimeKit needs nothing more than its token. */
export type VideoJoinTarget =
  | { provider: 'realtimekit' }
  | { provider: 'livekit'; url: string };

/** `url` without the slashes it ends with. */
export function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end -= 1;
  return url.slice(0, end);
}

/** The provider a config value names; anything unknown or absent is RealtimeKit. */
export function parseVideoProvider(value: unknown): VideoProvider {
  return typeof value === 'string' && value.trim().toLowerCase() === 'livekit' ? 'livekit' : 'realtimekit';
}

/**
 * The join target for a provider and server URL. LiveKit without a usable
 * URL can't be joined, so it is an error rather than a silent fall back to
 * RealtimeKit (whose token this is not).
 */
export function videoJoinTarget(provider: unknown, url: unknown): VideoJoinTarget {
  if (parseVideoProvider(provider) === 'realtimekit') return { provider: 'realtimekit' };
  const server = typeof url === 'string' ? trimTrailingSlashes(url.trim()) : '';
  if (!/^(wss?|https?):\/\//i.test(server)) {
    throw new Error('LiveKit is the video provider, but no LiveKit server URL is configured');
  }
  return { provider: 'livekit', url: server };
}
