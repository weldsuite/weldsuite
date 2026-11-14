import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ liveKit: false, loaded: [] as string[] }));

vi.mock('@/lib/video-provider', () => ({ isLiveKit: () => state.liveKit }));
vi.mock('@weldsuite/weldmeet-ui/providers/livekit', () => {
  state.loaded.push('livekit');
  return {};
});
vi.mock('@cloudflare/realtimekit', () => {
  state.loaded.push('realtimekit');
  return { default: {} };
});

async function prefetch() {
  const { prefetchCallSdk } = await import('./prefetch-call-sdk');
  return prefetchCallSdk();
}

describe('prefetchCallSdk', () => {
  beforeEach(() => {
    vi.resetModules();
    state.loaded = [];
  });

  it('warms RealtimeKit on Global', async () => {
    state.liveKit = false;
    await prefetch();
    expect(state.loaded).toEqual(['realtimekit']);
  });

  it('warms the LiveKit client on the Kubernetes editions, never RealtimeKit', async () => {
    state.liveKit = true;
    await prefetch();
    expect(state.loaded).toEqual(['livekit']);
  });

  it('ignores a chunk that fails to load', async () => {
    state.liveKit = true;
    vi.doMock('@weldsuite/weldmeet-ui/providers/livekit', () => {
      throw new Error('chunk failed to load');
    });
    await expect(prefetch()).resolves.toBeUndefined();
    expect(state.loaded).toEqual([]);
  });
});
