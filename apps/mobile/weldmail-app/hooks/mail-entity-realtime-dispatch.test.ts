/**
 * Unit tests for Mail hub-entity → surface dispatch (Phase 7).
 * Run via: pnpm --filter platform exec vitest run ../../mobile/weldmail-app/hooks/mail-entity-realtime-dispatch.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import {
  MAIL_ENTITY_HUB_TOPICS,
  dispatchMailEntityRealtimeEvent,
  surfacesForMailEntityTopic,
  type MailEntityRealtimeSurface,
} from './mail-entity-realtime-dispatch';

describe('surfacesForMailEntityTopic', () => {
  it('maps email + leftovers to list surfaces', () => {
    expect(surfacesForMailEntityTopic('email')).toEqual(['inbox']);
    expect(surfacesForMailEntityTopic('mail_campaign')).toEqual(['campaigns']);
    expect(surfacesForMailEntityTopic('mail_signature')).toEqual(['signatures']);
    expect(surfacesForMailEntityTopic('email_rule')).toEqual(['rules']);
    expect(surfacesForMailEntityTopic('email_template')).toEqual(['templates']);
  });

  it('returns empty for unknown topics', () => {
    expect(surfacesForMailEntityTopic('invoice')).toEqual([]);
    expect(surfacesForMailEntityTopic('mail')).toEqual([]);
  });
});

describe('dispatchMailEntityRealtimeEvent', () => {
  it('fires per-surface + any for known topics', () => {
    const seen: MailEntityRealtimeSurface[] = [];
    dispatchMailEntityRealtimeEvent('email', 'created', {
      onInvalidate: (surface) => seen.push(surface),
    });
    expect(seen).toEqual(['inbox', 'any']);
  });

  it('no-ops when handler missing or topic unknown', () => {
    expect(() =>
      dispatchMailEntityRealtimeEvent('email', 'created', {}),
    ).not.toThrow();
    const onInvalidate = vi.fn();
    dispatchMailEntityRealtimeEvent('unknown_topic', 'created', { onInvalidate });
    expect(onInvalidate).not.toHaveBeenCalled();
  });

  it('covers every MAIL_ENTITY_HUB_TOPICS entry', () => {
    for (const topic of MAIL_ENTITY_HUB_TOPICS) {
      expect(surfacesForMailEntityTopic(topic).length).toBeGreaterThan(0);
    }
  });
});
