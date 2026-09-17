/**
 * Pure Social hub-event → surface dispatch for weldsocial-app.
 * Kept React-free so it can be unit-tested without jest-expo.
 *
 * No QueryClient on this app yet (imperative useAsyncData / local state).
 * Screens pass an onInvalidate callback keyed by surface.
 */

export type SocialRealtimeSurface =
  | 'dashboard'
  | 'queue'
  | 'approvals'
  | 'calendar'
  | 'accounts'
  | 'campaigns'
  | 'analytics'
  | 'post'
  | 'any';

export interface SocialRealtimeHandlers {
  /** Fired when a hub event should refresh the given UI surface. */
  onInvalidate?: (surface: SocialRealtimeSurface) => void;
}

/** Hub entity topics that affect the WeldSocial mobile shell. */
export const SOCIAL_HUB_TOPICS = [
  'social_account',
  'social_approval',
  'social_campaign',
  'social_media',
  'social_post',
  'social_settings',
  'social_team_member',
] as const;

export type SocialHubTopic = (typeof SOCIAL_HUB_TOPICS)[number];

const TOPIC_SURFACES: Record<SocialHubTopic, SocialRealtimeSurface[]> = {
  social_account: ['accounts', 'dashboard', 'queue'],
  social_approval: ['approvals', 'queue', 'dashboard'],
  social_campaign: ['campaigns', 'dashboard'],
  social_media: ['any'],
  social_post: ['queue', 'calendar', 'dashboard', 'post', 'approvals'],
  social_settings: ['any'],
  social_team_member: ['any'],
};

/**
 * Map a hub topic to UI surfaces that should reload.
 * Returns [] for unknown topics.
 */
export function surfacesForSocialTopic(topic: string): SocialRealtimeSurface[] {
  const surfaces = TOPIC_SURFACES[topic as SocialHubTopic];
  return surfaces ? [...surfaces] : [];
}

/**
 * Dispatch a hub event to the Social invalidate callback.
 * Always also fires `any` so screens that want "anything social" can listen.
 */
export function dispatchSocialRealtimeEvent(
  topic: string,
  _event: string,
  handlers: SocialRealtimeHandlers,
): void {
  const onInvalidate = handlers.onInvalidate;
  if (!onInvalidate) return;

  const surfaces = surfacesForSocialTopic(topic);
  if (surfaces.length === 0) return;

  const seen = new Set<SocialRealtimeSurface>();
  for (const surface of surfaces) {
    if (seen.has(surface)) continue;
    seen.add(surface);
    onInvalidate(surface);
  }
  if (!seen.has('any')) {
    onInvalidate('any');
  }
}
