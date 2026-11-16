import { callJoinTarget } from '../video-provider';

describe('callJoinTarget', () => {
  it('joins with RealtimeKit on WeldSuite cloud, whose runtime names no provider', () => {
    expect(callJoinTarget({ videoProvider: null, videoUrl: null })).toEqual({ provider: 'realtimekit' });
  });

  it('joins with RealtimeKit when the server says so', () => {
    expect(callJoinTarget({ videoProvider: 'realtimekit', videoUrl: null })).toEqual({ provider: 'realtimekit' });
  });

  it('joins with LiveKit at the server a Kubernetes edition names', () => {
    expect(
      callJoinTarget({ videoProvider: 'livekit', videoUrl: 'wss://livekit.eu.weldsuite.org/' }),
    ).toEqual({ provider: 'livekit', url: 'wss://livekit.eu.weldsuite.org' });
  });

  it('reads the provider name as the platform does', () => {
    expect(callJoinTarget({ videoProvider: ' LiveKit ', videoUrl: 'https://media.example.org' })).toEqual({
      provider: 'livekit',
      url: 'https://media.example.org',
    });
  });

  it('cannot join on LiveKit without a usable server URL', () => {
    expect(callJoinTarget({ videoProvider: 'livekit', videoUrl: null })).toBeNull();
    expect(callJoinTarget({ videoProvider: 'livekit', videoUrl: 'livekit.example.org' })).toBeNull();
  });

  it('treats a provider it does not know as RealtimeKit', () => {
    expect(callJoinTarget({ videoProvider: 'jitsi', videoUrl: 'wss://meet.example.org' })).toEqual({
      provider: 'realtimekit',
    });
  });
});
