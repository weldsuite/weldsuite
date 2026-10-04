import { describe, expect, it } from 'vitest';
import { NON_CHANNEL_SEGMENTS, parseWeldChatPath } from './route-segments';

describe('parseWeldChatPath', () => {
  it('reads the channel id of a channel page', () => {
    expect(parseWeldChatPath('/weldchat/chn_123')).toEqual({
      channelId: 'chn_123',
      isChannelPage: true,
      isDmPage: false,
      isGroupDm: false,
    });
  });

  it('still names the channel on the dedicated thread route', () => {
    const location = parseWeldChatPath('/weldchat/chn_123/thread/msg_9');
    expect(location.channelId).toBe('chn_123');
    expect(location.isChannelPage).toBe(true);
  });

  it('reads the other member of a 1:1 DM page', () => {
    expect(parseWeldChatPath('/weldchat/dm/user_42')).toEqual({
      channelId: 'user_42',
      isChannelPage: false,
      isDmPage: true,
      isGroupDm: false,
    });
  });

  it('reads the channel id of a group DM page, not the literal "group"', () => {
    expect(parseWeldChatPath('/weldchat/dm/group/chn_grp')).toEqual({
      channelId: 'chn_grp',
      isChannelPage: false,
      isDmPage: true,
      isGroupDm: true,
    });
  });

  it.each(['/weldchat/dm', '/weldchat/dm/', '/weldchat/dm/group'])(
    'treats %s as no conversation (the literal "dm" is not a channel id)',
    (path) => {
      expect(parseWeldChatPath(path)).toEqual({
        channelId: '',
        isChannelPage: false,
        isDmPage: false,
        isGroupDm: false,
      });
    },
  );

  it.each([...NON_CHANNEL_SEGMENTS])('never counts the sibling route "%s" as a channel', (segment) => {
    const location = parseWeldChatPath(`/weldchat/${segment}`);
    expect(location.channelId).toBe('');
    expect(location.isChannelPage).toBe(false);
  });

  it('covers every WeldChat sibling route', () => {
    for (const segment of ['dm', 'activity', 'drafts', 'directories', 'bookmarks', 'search', 'thread']) {
      expect(NON_CHANNEL_SEGMENTS.has(segment)).toBe(true);
    }
  });

  it('handles the module root and missing paths', () => {
    expect(parseWeldChatPath('/weldchat').channelId).toBe('');
    expect(parseWeldChatPath('/weldchat/').channelId).toBe('');
    expect(parseWeldChatPath(undefined).channelId).toBe('');
    expect(parseWeldChatPath(null).isChannelPage).toBe(false);
  });
});
