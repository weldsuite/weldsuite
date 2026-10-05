import { describe, expect, it } from 'vitest';
import { getDraftDestination, hasDraftContent } from './draft-utils';

describe('hasDraftContent', () => {
  it('is true for text', () => {
    expect(hasDraftContent({ content: 'hello' })).toBe(true);
  });

  it('is true for attachments without text', () => {
    expect(hasDraftContent({ content: '', attachments: [{ id: 'att_1' }] })).toBe(true);
  });

  it('is false for empty or whitespace-only drafts with no attachments', () => {
    expect(hasDraftContent({ content: '' })).toBe(false);
    expect(hasDraftContent({ content: '  \n ', attachments: [] })).toBe(false);
    expect(hasDraftContent({ content: null, attachments: null })).toBe(false);
  });
});

describe('getDraftDestination', () => {
  it('sends a thread draft to its thread so the thread composer restores it', () => {
    expect(getDraftDestination({ channelId: 'chn_1', threadParentMessageId: 'msg_7' })).toEqual({
      kind: 'thread',
      channelId: 'chn_1',
      messageId: 'msg_7',
    });
  });

  it('sends a channel draft to the channel', () => {
    expect(getDraftDestination({ channelId: 'chn_1', threadParentMessageId: null })).toEqual({
      kind: 'channel',
      channelId: 'chn_1',
    });
  });

  it('has nowhere to go without a channel', () => {
    expect(getDraftDestination({ channelId: null, threadParentMessageId: 'msg_7' })).toBeNull();
  });
});
