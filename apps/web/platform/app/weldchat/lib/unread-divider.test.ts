import { describe, expect, it } from 'vitest';
import { firstUnreadMessageId, mergeUnreadMarker } from './unread-divider';

const T = (minute: number) => new Date(Date.UTC(2026, 9, 8, 9, minute)).toISOString();

describe('mergeUnreadMarker', () => {
  it('takes the first answer for the shown channel', () => {
    expect(mergeUnreadMarker(undefined, 'ch_a', { channelId: 'ch_a', since: T(1), until: T(5) })).toEqual({
      channelId: 'ch_a',
      since: T(1),
      until: T(5),
    });
  });

  it('keeps the earliest since and the latest until when the open runs twice', () => {
    const first = mergeUnreadMarker(undefined, 'ch_a', { channelId: 'ch_a', since: T(1), until: T(5) });
    // The second call sees the first call's read position as its "since".
    const both = mergeUnreadMarker(first, 'ch_a', { channelId: 'ch_a', since: T(5), until: T(6) });
    expect(both).toEqual({ channelId: 'ch_a', since: T(1), until: T(6) });
    // Same result when the answers arrive the other way round.
    const reversed = mergeUnreadMarker(
      mergeUnreadMarker(undefined, 'ch_a', { channelId: 'ch_a', since: T(5), until: T(6) }),
      'ch_a',
      { channelId: 'ch_a', since: T(1), until: T(5) },
    );
    expect(reversed).toEqual(both);
  });

  it('ignores an answer for a channel that is no longer shown', () => {
    expect(mergeUnreadMarker(undefined, 'ch_b', { channelId: 'ch_a', since: T(1), until: T(5) })).toBeUndefined();
  });

  it('draws no line for a member who had never read the channel', () => {
    expect(mergeUnreadMarker(undefined, 'ch_a', { channelId: 'ch_a', since: null, until: T(5) })).toBeNull();
    const marker = mergeUnreadMarker(undefined, 'ch_a', { channelId: 'ch_a', since: T(5), until: T(6) });
    expect(mergeUnreadMarker(marker, 'ch_a', { channelId: 'ch_a', since: null, until: T(5) })).toBeNull();
  });
});

describe('firstUnreadMessageId', () => {
  const messages = [
    { id: 'm1', createdAt: T(0), authorId: 'u_other' },
    { id: 'm2', createdAt: T(2), authorId: 'u_me' },
    { id: 'm3', createdAt: T(3), authorId: 'u_other' },
    { id: 'm4', createdAt: T(4), authorId: 'u_other' },
    { id: 'm5', createdAt: T(9), authorId: 'u_other' },
  ];

  it('is the first message from someone else after the read position', () => {
    expect(firstUnreadMessageId(messages, { since: T(1), until: T(5) }, 'u_me')).toBe('m3');
  });

  it('ignores messages that arrived after the channel was opened', () => {
    expect(firstUnreadMessageId(messages, { since: T(4), until: T(5) }, 'u_me')).toBeNull();
  });

  it('is null without a marker', () => {
    expect(firstUnreadMessageId(messages, null, 'u_me')).toBeNull();
  });
});
