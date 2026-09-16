import { describe, it, expect } from 'vitest';
import {
  defineEntityEventSubscribers,
  topicMatches,
  matchEntityEventSubscribers,
  ENTITY_EVENT_SUBSCRIBERS,
} from './subscribers';

describe('topicMatches', () => {
  it('matches wildcard *', () => {
    expect(topicMatches(['*'], 'customer:created')).toBe(true);
    expect(topicMatches(['*'], 'order:updated')).toBe(true);
  });

  it('matches entityType:*', () => {
    expect(topicMatches(['customer:*'], 'customer:created')).toBe(true);
    expect(topicMatches(['customer:*'], 'customer:updated')).toBe(true);
    expect(topicMatches(['customer:*'], 'order:created')).toBe(false);
  });

  it('matches exact entityType:action', () => {
    expect(topicMatches(['customer:created'], 'customer:created')).toBe(true);
    expect(topicMatches(['customer:created'], 'customer:updated')).toBe(false);
  });

  it('returns true if any pattern matches', () => {
    expect(topicMatches(['order:*', 'customer:created'], 'customer:created')).toBe(true);
    expect(topicMatches(['order:*', 'customer:created'], 'invoice:created')).toBe(false);
  });

  it('rejects malformed event types', () => {
    expect(topicMatches(['*'], '')).toBe(false);
    expect(topicMatches(['*'], 'nocolon')).toBe(false);
    expect(topicMatches(['*'], ':created')).toBe(false);
    expect(topicMatches(['*'], 'customer:')).toBe(false);
  });
});

describe('defineEntityEventSubscribers', () => {
  it('accepts a valid registry', () => {
    const subs = defineEntityEventSubscribers([
      { id: 'a', topics: ['*'], queueBinding: 'SUB_AUDIT' },
    ] as const);
    expect(subs).toHaveLength(1);
  });

  it('rejects duplicate ids', () => {
    expect(() =>
      defineEntityEventSubscribers([
        { id: 'a', topics: ['*'], queueBinding: 'SUB_AUDIT' },
        { id: 'a', topics: ['*'], queueBinding: 'SUB_ANALYTICS' },
      ]),
    ).toThrow(/duplicate subscriber id/);
  });

  it('rejects empty topics', () => {
    expect(() =>
      defineEntityEventSubscribers([
        { id: 'a', topics: [], queueBinding: 'SUB_AUDIT' },
      ]),
    ).toThrow(/at least one topic/);
  });
});

describe('ENTITY_EVENT_SUBSCRIBERS registry', () => {
  it('includes Phase 1–4 audit/analytics/search/webhooks/weldconnect subscribers', () => {
    const ids = ENTITY_EVENT_SUBSCRIBERS.map((s) => s.id).sort();
    expect(ids).toEqual(['analytics', 'audit', 'search-index', 'webhooks', 'weldconnect']);
  });

  it('matches all Phase 1–4 subscribers for a typical event', () => {
    const matched = matchEntityEventSubscribers('customer:created');
    expect(matched.map((s) => s.id).sort()).toEqual([
      'analytics',
      'audit',
      'search-index',
      'webhooks',
      'weldconnect',
    ]);
  });

  it('webhooks subscriber binds SUB_WEBHOOKS', () => {
    const webhooks = ENTITY_EVENT_SUBSCRIBERS.find((s) => s.id === 'webhooks');
    expect(webhooks?.queueBinding).toBe('SUB_WEBHOOKS');
    expect(webhooks?.topics).toEqual(['*']);
  });

  it('weldconnect subscriber binds SUB_WELDCONNECT', () => {
    const weldconnect = ENTITY_EVENT_SUBSCRIBERS.find((s) => s.id === 'weldconnect');
    expect(weldconnect?.queueBinding).toBe('SUB_WELDCONNECT');
    expect(weldconnect?.topics).toEqual(['*']);
  });

  it('respects per-subscriber topic filters', () => {
    const custom = defineEntityEventSubscribers([
      { id: 'orders-only', topics: ['order:*'], queueBinding: 'SUB_AUDIT' },
      { id: 'all', topics: ['*'], queueBinding: 'SUB_ANALYTICS' },
    ] as const);
    expect(matchEntityEventSubscribers('order:created', custom).map((s) => s.id)).toEqual([
      'orders-only',
      'all',
    ]);
    expect(matchEntityEventSubscribers('customer:created', custom).map((s) => s.id)).toEqual([
      'all',
    ]);
  });
});
