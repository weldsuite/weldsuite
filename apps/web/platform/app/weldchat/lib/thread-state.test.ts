import { describe, expect, it } from 'vitest';
import { threadAfterChannelChange, threadMessageIdFor } from './thread-state';

const threadInA = { channelId: 'chn_a', messageId: 'msg_1' };

describe('threadMessageIdFor', () => {
  it('shows the thread only in the channel it was opened in', () => {
    expect(threadMessageIdFor(threadInA, 'chn_a')).toBe('msg_1');
    expect(threadMessageIdFor(threadInA, 'chn_b')).toBeNull();
    expect(threadMessageIdFor(null, 'chn_a')).toBeNull();
  });
});

describe('threadAfterChannelChange', () => {
  it('closes a thread that belongs to the previous channel', () => {
    expect(threadAfterChannelChange(threadInA, 'chn_b')).toBeNull();
  });

  it('keeps a thread that was opened for the new channel in the same commit (jump link)', () => {
    const jumped = { channelId: 'chn_b', messageId: 'msg_9' };
    expect(threadAfterChannelChange(jumped, 'chn_b')).toBe(jumped);
  });

  it('leaves "no thread" alone', () => {
    expect(threadAfterChannelChange(null, 'chn_b')).toBeNull();
  });
});
