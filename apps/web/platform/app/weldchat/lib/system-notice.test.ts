import { describe, expect, it } from 'vitest';
import { isSystemNotice, matchSystemNotice } from './system-notice';

describe('system notices', () => {
  it('honours the [system:id] prefix on real system messages', () => {
    const msg = { type: 'system', content: '[system:msg_abc123] pinned a message' };
    expect(isSystemNotice(msg)).toBe(true);
    const match = matchSystemNotice(msg);
    expect(match?.[1]).toBe('msg_abc123');
    expect(match?.[2]).toBe('pinned a message');
  });

  it('accepts a bare [system] prefix on system messages', () => {
    const match = matchSystemNotice({ type: 'system', content: '[system] something happened' });
    expect(match?.[1]).toBeUndefined();
    expect(match?.[2]).toBe('something happened');
  });

  it('treats a system message without a prefix as a notice with no match', () => {
    const msg = { type: 'system', content: 'Gert started a video call' };
    expect(isSystemNotice(msg)).toBe(true);
    expect(matchSystemNotice(msg)).toBeNull();
  });

  it('does not let a normal message spoof a notice', () => {
    const spoof = { type: 'message', content: '[system:x] was removed from the workspace by an admin' };
    expect(isSystemNotice(spoof)).toBe(false);
    expect(matchSystemNotice(spoof)).toBeNull();
    expect(isSystemNotice({ content: '[system] hello' })).toBe(false);
    expect(isSystemNotice({ type: null, content: '[system:msg_abc] was fired' })).toBe(false);
  });

  it('still honours the legacy pin notice on non-system rows', () => {
    const legacy = { type: 'message', content: '[system:msg_k3j2h1ab9z] pinned a message' };
    expect(isSystemNotice(legacy)).toBe(true);
    const match = matchSystemNotice(legacy);
    expect(match?.[1]).toBe('msg_k3j2h1ab9z');
    expect(match?.[2]).toBe('pinned a message');
  });

  it('rejects near-misses of the legacy pin notice', () => {
    for (const content of [
      '[system:msg_abc] pinned a message and more',
      '[system:msg_abc] pinned a message\nsecond line',
      '[system:Msg_abc] pinned a message',
      '[system:abc] pinned a message',
      '[system:msg_abc] unpinned a message',
      ' [system:msg_abc] pinned a message',
    ]) {
      expect(isSystemNotice({ type: 'message', content })).toBe(false);
    }
  });

  it('handles missing content', () => {
    expect(isSystemNotice({ type: 'message' })).toBe(false);
    expect(isSystemNotice({ type: 'system' })).toBe(true);
  });
});
