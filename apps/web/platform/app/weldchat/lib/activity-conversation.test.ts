import { describe, expect, it } from 'vitest';
import { activityChannelId } from './activity-conversation';

describe('activityChannelId', () => {
  it("uses the row's channel id when it has one", () => {
    expect(activityChannelId({ channelId: 'ch_general', actionUrl: '/weldchat/dm/ch_other' })).toBe('ch_general');
  });

  it("reads a DM's or a channel's id from the link otherwise", () => {
    expect(activityChannelId({ channelId: null, actionUrl: '/weldchat/dm/ch_mwqep8i7i3azj27z' })).toBe('ch_mwqep8i7i3azj27z');
    expect(activityChannelId({ channelId: null, actionUrl: '/weldchat/ch_abc/thread/msg_1' })).toBe('ch_abc');
  });

  it('has none for a link that names no conversation', () => {
    expect(activityChannelId({ channelId: null, actionUrl: '/weldchat/activity' })).toBeNull();
    expect(activityChannelId({ channelId: null, actionUrl: null })).toBeNull();
  });
});
