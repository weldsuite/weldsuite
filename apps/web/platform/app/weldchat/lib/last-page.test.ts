import { describe, expect, it } from 'vitest';
import { parseLastWeldChatPage } from './last-page';

describe('parseLastWeldChatPage', () => {
  it('remembers a channel page by its channel', () => {
    expect(parseLastWeldChatPage('/weldchat/chn_123')).toEqual({
      kind: 'channel',
      path: '/weldchat/chn_123',
      channelId: 'chn_123',
    });
  });

  it('remembers a thread page, checked through its channel', () => {
    expect(parseLastWeldChatPage('/weldchat/chn_123/thread/msg_9')).toEqual({
      kind: 'channel',
      path: '/weldchat/chn_123/thread/msg_9',
      channelId: 'chn_123',
    });
  });

  it('remembers a 1:1 DM page by the other member', () => {
    expect(parseLastWeldChatPage('/weldchat/dm/user_42')).toEqual({
      kind: 'dm',
      path: '/weldchat/dm/user_42',
      userId: 'user_42',
    });
  });

  it('remembers a group DM page by its channel', () => {
    expect(parseLastWeldChatPage('/weldchat/dm/group/chn_grp')).toEqual({
      kind: 'channel',
      path: '/weldchat/dm/group/chn_grp',
      channelId: 'chn_grp',
    });
  });

  it.each(['dm', 'activity', 'drafts', 'directories', 'bookmarks', 'records', 'search'])(
    'remembers the module page /weldchat/%s without a lookup',
    (segment) => {
      expect(parseLastWeldChatPage(`/weldchat/${segment}`)).toEqual({ kind: 'page', path: `/weldchat/${segment}` });
    },
  );

  it('drops a trailing slash', () => {
    expect(parseLastWeldChatPage('/weldchat/activity/')).toEqual({ kind: 'page', path: '/weldchat/activity' });
  });

  it.each([
    null,
    undefined,
    '',
    '/weldchat',
    '/weldchat/',
    '/weldchat/dm/group',
    '/weldchat/thread',
    '/weldchat/drafts/thread/msg_1',
    '/weldchat/chn_123/unknown',
    '/weldcrm/customers',
    '/preview/weldchat/chn_123',
  ])('remembers nothing for %s', (path) => {
    expect(parseLastWeldChatPage(path)).toBeNull();
  });
});
