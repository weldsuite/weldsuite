/**
 * Unit tests for Social hub-event → surface dispatch (Phase 6).
 * Run via: pnpm --filter platform exec vitest run ../../mobile/weldsocial-app/hooks/social-realtime-dispatch.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import {
  SOCIAL_HUB_TOPICS,
  dispatchSocialRealtimeEvent,
  surfacesForSocialTopic,
  type SocialRealtimeSurface,
} from './social-realtime-dispatch';

describe('surfacesForSocialTopic', () => {
  it('maps posts/approvals/accounts to list surfaces', () => {
    expect(surfacesForSocialTopic('social_post')).toEqual([
      'queue',
      'calendar',
      'dashboard',
      'post',
      'approvals',
    ]);
    expect(surfacesForSocialTopic('social_approval')).toEqual([
      'approvals',
      'queue',
      'dashboard',
    ]);
    expect(surfacesForSocialTopic('social_account')).toEqual([
      'accounts',
      'dashboard',
      'queue',
    ]);
  });

  it('returns empty for unknown topics', () => {
    expect(surfacesForSocialTopic('invoice')).toEqual([]);
    expect(surfacesForSocialTopic('helpdesk')).toEqual([]);
  });
});

describe('dispatchSocialRealtimeEvent', () => {
  it('fires per-surface + any for known topics', () => {
    const seen: SocialRealtimeSurface[] = [];
    dispatchSocialRealtimeEvent('social_campaign', 'created', {
      onInvalidate: (surface) => seen.push(surface),
    });
    expect(seen).toEqual(['campaigns', 'dashboard', 'any']);
  });

  it('no-ops when handler missing or topic unknown', () => {
    expect(() =>
      dispatchSocialRealtimeEvent('social_post', 'created', {}),
    ).not.toThrow();
    const onInvalidate = vi.fn();
    dispatchSocialRealtimeEvent('unknown_topic', 'created', { onInvalidate });
    expect(onInvalidate).not.toHaveBeenCalled();
  });

  it('covers every SOCIAL_HUB_TOPICS entry', () => {
    for (const topic of SOCIAL_HUB_TOPICS) {
      expect(surfacesForSocialTopic(topic).length).toBeGreaterThan(0);
    }
  });
});
