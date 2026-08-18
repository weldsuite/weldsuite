import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getAppApiUrl, getRealtimeUrl } from './public-env';

describe('getAppApiUrl', () => {
  const originalHostname = window.location.hostname;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, hostname: originalHostname },
    });
  });

  function stubHost(host: string) {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, hostname: host },
    });
  }

  it('uses localhost when the SPA is on localhost', () => {
    stubHost('localhost');
    vi.stubEnv('VITE_APP_API_URL', 'http://localhost:8789');
    expect(getAppApiUrl()).toBe('http://localhost:8789');
  });

  it('ignores a leaked localhost env URL on the test host', () => {
    stubHost('app-test.weldsuite.org');
    vi.stubEnv('VITE_APP_API_URL', 'http://localhost:8789');
    expect(getAppApiUrl()).toBe('https://app-api-test.weldsuite.org');
  });

  it('keeps an explicit non-local env URL on the test host', () => {
    stubHost('app-test.weldsuite.org');
    vi.stubEnv('VITE_APP_API_URL', 'https://app-api-test.weldsuite.org');
    expect(getAppApiUrl()).toBe('https://app-api-test.weldsuite.org');
  });
});

describe('getRealtimeUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('ignores a leaked localhost realtime URL on the test host', () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, hostname: 'app-test.weldsuite.org' },
    });
    vi.stubEnv('VITE_REALTIME_URL', 'ws://localhost:8790/ws');
    expect(getRealtimeUrl()).toBe('wss://realtime-test.weldsuite.org/ws');
  });
});
