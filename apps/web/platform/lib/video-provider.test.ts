import { afterEach, describe, expect, it } from 'vitest';
import { parseRuntimeConfig, setRuntimeConfig } from './runtime-config';
import { isLiveKit, videoJoin, videoProvider } from './video-provider';

afterEach(() => setRuntimeConfig(null));

describe('video provider', () => {
  it('joins with RealtimeKit on Global (no runtime config)', () => {
    expect(videoProvider()).toBe('realtimekit');
    expect(isLiveKit()).toBe(false);
    expect(videoJoin()).toEqual({ provider: 'realtimekit' });
  });

  it('joins with RealtimeKit when the backend names no provider or RealtimeKit', () => {
    setRuntimeConfig({ backend: 'rust' });
    expect(videoJoin()).toEqual({ provider: 'realtimekit' });
    setRuntimeConfig({ backend: 'rust', videoProvider: 'realtimekit' });
    expect(isLiveKit()).toBe(false);
  });

  it('joins the LiveKit server the Rust backend names', () => {
    const config = parseRuntimeConfig({
      backend: 'rust',
      edition: 'eu',
      videoProvider: 'livekit',
      videoUrl: 'wss://livekit.example.eu',
    });
    expect(config).not.toBeNull();
    setRuntimeConfig(config);
    expect(isLiveKit()).toBe(true);
    expect(videoJoin()).toEqual({ provider: 'livekit', url: 'wss://livekit.example.eu' });
  });

  it('refuses to join LiveKit without its server, and a bad value never voids the document', () => {
    const config = parseRuntimeConfig({ backend: 'rust', modules: ['core', 'meet'], videoProvider: 'livekit', videoUrl: 'nope' });
    expect(config?.modules).toEqual(['core', 'meet']);
    setRuntimeConfig(config);
    expect(() => videoJoin()).toThrow(/LiveKit server URL/);
  });
});
