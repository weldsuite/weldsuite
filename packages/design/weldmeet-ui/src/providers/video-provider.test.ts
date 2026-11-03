import { describe, expect, it } from 'vitest';
import { parseVideoProvider, videoJoinTarget } from './video-provider';

describe('video provider', () => {
  it('is RealtimeKit unless LiveKit is named (Global sends nothing)', () => {
    expect(parseVideoProvider(undefined)).toBe('realtimekit');
    expect(parseVideoProvider(null)).toBe('realtimekit');
    expect(parseVideoProvider('realtimekit')).toBe('realtimekit');
    expect(parseVideoProvider('something-new')).toBe('realtimekit');
    expect(parseVideoProvider('livekit')).toBe('livekit');
    expect(parseVideoProvider(' LiveKit ')).toBe('livekit');
  });

  it('joins LiveKit at its server URL and refuses LiveKit without one', () => {
    expect(videoJoinTarget(undefined, 'wss://lk.example.eu')).toEqual({ provider: 'realtimekit' });
    expect(videoJoinTarget('livekit', 'wss://lk.example.eu/')).toEqual({ provider: 'livekit', url: 'wss://lk.example.eu' });
    expect(() => videoJoinTarget('livekit', undefined)).toThrow(/LiveKit server URL/);
    expect(() => videoJoinTarget('livekit', 'lk.example.eu')).toThrow(/LiveKit server URL/);
  });
});
