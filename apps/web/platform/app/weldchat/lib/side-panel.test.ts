import { describe, expect, it } from 'vitest';
import { sidePanelChannelId } from './side-panel';

const channel = { currentChannelId: 'ch_general', activeChannelId: 'ch_general', isDmPage: false };
const dm = { currentChannelId: 'usr_gert', activeChannelId: 'ch_dm_gert', isDmPage: true };

describe('sidePanelChannelId', () => {
  it("shows every panel for the channel in the address", () => {
    expect(sidePanelChannelId('thread', channel)).toBe('ch_general');
    expect(sidePanelChannelId('pinned', channel)).toBe('ch_general');
  });

  it("opens a DM's thread in the DM's own conversation, not the other person's id", () => {
    expect(sidePanelChannelId('thread', dm)).toBe('ch_dm_gert');
  });

  it('waits for the DM page to report its conversation before showing a thread', () => {
    expect(sidePanelChannelId('thread', { ...dm, activeChannelId: null })).toBeNull();
  });

  it('keeps bookmarks and filters in a DM, and shows no pinned panel there', () => {
    expect(sidePanelChannelId('bookmarks', dm)).toBe('usr_gert');
    expect(sidePanelChannelId('filters', dm)).toBe('usr_gert');
    expect(sidePanelChannelId('pinned', dm)).toBeNull();
  });

  it('shows nothing without a panel or a conversation', () => {
    expect(sidePanelChannelId(null, channel)).toBeNull();
    expect(sidePanelChannelId('thread', { ...channel, currentChannelId: '' })).toBeNull();
  });
});
