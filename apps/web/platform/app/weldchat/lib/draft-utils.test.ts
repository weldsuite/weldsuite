import { describe, expect, it } from 'vitest';
import { dmDisplayName, getDraftDestination, hasDraftContent } from './draft-utils';

describe('dmDisplayName', () => {
  it('names a DM after the other people in it', () => {
    expect(
      dmDisplayName({
        id: 'ch_1',
        members: [{ userId: 'me', name: 'Me' }, { userId: 'u2', name: 'Ann' }, { userId: 'u3', name: 'Bob' }],
        otherMembers: [{ userId: 'u2', name: 'Ann' }, { userId: 'u3', name: 'Bob' }],
      }),
    ).toBe('Ann, Bob');
  });

  it('uses your own name for the DM with yourself', () => {
    expect(dmDisplayName({ id: 'ch_2', members: [{ userId: 'me', name: 'Gert' }], otherMembers: [] })).toBe('Gert');
  });

  it('is null when nobody has a name', () => {
    expect(dmDisplayName({ id: 'ch_3', members: [{ userId: 'me', name: null }], otherMembers: [{ userId: 'u2' }] })).toBeNull();
  });
});

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
