import { describe, expect, it } from 'vitest';
import { withChannelCall, type ActiveCallEntry } from './active-calls';

const dm: ActiveCallEntry = { channelId: 'ch_dm', callId: 'call_1', callType: 'voice' };
const team: ActiveCallEntry = { channelId: 'ch_team', callId: 'call_2', callType: 'video' };

describe('withChannelCall', () => {
  it('drops a call the conversation no longer has (a missed call_ended)', () => {
    expect(withChannelCall([dm, team], 'ch_dm', null)).toEqual([team]);
  });

  it('adds a call the list missed', () => {
    expect(withChannelCall([team], 'ch_dm', { id: 'call_1', callType: 'voice' })).toEqual([team, dm]);
  });

  it('replaces an ended call with the one now live in the same conversation', () => {
    expect(withChannelCall([dm], 'ch_dm', { id: 'call_3', callType: 'video' })).toEqual([
      { channelId: 'ch_dm', callId: 'call_3', callType: 'video' },
    ]);
  });

  it('returns the same array when the check agrees', () => {
    const list = [dm, team];
    expect(withChannelCall(list, 'ch_dm', { id: 'call_1', callType: 'voice' })).toBe(list);
    expect(withChannelCall(list, 'ch_other', null)).toBe(list);
  });
});
