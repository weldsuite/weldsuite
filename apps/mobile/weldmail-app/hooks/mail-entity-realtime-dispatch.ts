/**
 * Pure mail hub-event → surface dispatch for weldmail-app.
 * Kept React-free so it can be unit-tested without jest-expo.
 *
 * No QueryClient on this app yet (MailContext / imperative fetch).
 * Full useRealtimeSync trails in Phase 8 once Mail adopts TanStack Query.
 * Personal `mail.{userId}` / mail:new stays on useMailRealtime.
 */

export type MailEntityRealtimeSurface =
  | 'inbox'
  | 'campaigns'
  | 'signatures'
  | 'rules'
  | 'templates'
  | 'any';

export interface MailEntityRealtimeHandlers {
  /** Fired when a hub event should refresh the given UI surface. */
  onInvalidate?: (surface: MailEntityRealtimeSurface) => void;
}

/** Hub entity topics that affect the WeldMail mobile shell (Phase 7 leftovers + inbox). */
export const MAIL_ENTITY_HUB_TOPICS = [
  'email',
  'mail_campaign',
  'mail_signature',
  'email_rule',
  'email_template',
] as const;

export type MailEntityHubTopic = (typeof MAIL_ENTITY_HUB_TOPICS)[number];

const TOPIC_SURFACES: Record<MailEntityHubTopic, MailEntityRealtimeSurface[]> = {
  email: ['inbox'],
  mail_campaign: ['campaigns'],
  mail_signature: ['signatures'],
  email_rule: ['rules'],
  email_template: ['templates'],
};

/**
 * Map a hub topic to UI surfaces that should reload.
 * Returns [] for unknown topics.
 */
export function surfacesForMailEntityTopic(topic: string): MailEntityRealtimeSurface[] {
  const surfaces = TOPIC_SURFACES[topic as MailEntityHubTopic];
  return surfaces ? [...surfaces] : [];
}

/**
 * Dispatch a hub event to the Mail invalidate callback.
 * Always also fires `any` so screens that want "anything mail" can listen.
 */
export function dispatchMailEntityRealtimeEvent(
  topic: string,
  _event: string,
  handlers: MailEntityRealtimeHandlers,
): void {
  const onInvalidate = handlers.onInvalidate;
  if (!onInvalidate) return;

  const surfaces = surfacesForMailEntityTopic(topic);
  if (surfaces.length === 0) return;

  const seen = new Set<MailEntityRealtimeSurface>();
  for (const surface of surfaces) {
    if (seen.has(surface)) continue;
    seen.add(surface);
    onInvalidate(surface);
  }
  if (!seen.has('any')) {
    onInvalidate('any');
  }
}
