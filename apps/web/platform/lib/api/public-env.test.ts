import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { apiUrl, getApiOriginForPath, getApiOrigins, getAppApiUrl, getRealtimeUrl } from './public-env';
import { setRuntimeConfig } from '@/lib/runtime-config';

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

describe('per-module API origins', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function stubHost(host: string) {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, hostname: host },
    });
  }

  it('sends everything to app-api when no module is enabled', () => {
    stubHost('app.weldsuite.org');
    vi.stubEnv('VITE_APP_API_URL', '');
    vi.stubEnv('VITE_API_MODULES', '');
    expect(apiUrl('/api/weldpass/projects')).toBe('https://app-api.weldsuite.org/api/weldpass/projects');
    expect(getApiOrigins()).toEqual(['https://app-api.weldsuite.org']);
  });

  it('sends enabled modules to their own host on the test SPA', () => {
    stubHost('app-test.weldsuite.org');
    vi.stubEnv('VITE_APP_API_URL', '');
    vi.stubEnv('VITE_API_MODULES', 'pass');
    expect(getApiOriginForPath('/api/weldpass')).toBe('https://pass-api-test.weldsuite.org');
    expect(getApiOriginForPath('/api/tickets')).toBe('https://app-api-test.weldsuite.org');
    expect(getApiOrigins()).toEqual(['https://app-api-test.weldsuite.org', 'https://pass-api-test.weldsuite.org']);
  });

  it('uses the module dev port locally and honours explicit overrides', () => {
    stubHost('localhost');
    vi.stubEnv('VITE_APP_API_URL', 'http://localhost:8789');
    vi.stubEnv('VITE_API_MODULES', 'pass,host');
    vi.stubEnv('VITE_HOST_API_URL', 'http://localhost:9999');
    expect(getApiOriginForPath('/api/weldpass')).toBe('http://localhost:8820');
    expect(getApiOriginForPath('/api/domains')).toBe('http://localhost:9999');
  });

  it('ignores a leaked localhost module override on a hosted SPA', () => {
    stubHost('app.weldsuite.org');
    vi.stubEnv('VITE_APP_API_URL', '');
    vi.stubEnv('VITE_API_MODULES', 'pass');
    vi.stubEnv('VITE_PASS_API_URL', 'http://localhost:8820');
    expect(getApiOriginForPath('/api/weldpass')).toBe('https://pass-api.weldsuite.org');
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

describe('runtime config (/config.json)', () => {
  afterEach(() => {
    setRuntimeConfig(null);
    vi.unstubAllEnvs();
  });

  function stubLocation(origin: string) {
    const url = new URL(origin);
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, hostname: url.hostname, origin: url.origin },
    });
  }

  it('wins over the build-time values', () => {
    stubLocation('https://app.weldsuite.org');
    vi.stubEnv('VITE_APP_API_URL', 'https://app-api.weldsuite.org');
    setRuntimeConfig({ apiBaseUrl: 'https://api.example.eu/', realtimeUrl: 'wss://rt.example.eu/ws' });
    expect(getAppApiUrl()).toBe('https://api.example.eu');
    expect(getRealtimeUrl()).toBe('wss://rt.example.eu/ws');
  });

  it('trusts a stated localhost URL (a local Kubernetes run)', () => {
    stubLocation('https://weldsuite.example.eu');
    setRuntimeConfig({ apiBaseUrl: 'http://localhost:8080' });
    expect(getAppApiUrl()).toBe('http://localhost:8080');
  });

  it('sends every module to the SPA origin on the Rust backend', () => {
    stubLocation('https://weldsuite.example.eu');
    vi.stubEnv('VITE_API_MODULES', 'all');
    setRuntimeConfig({ backend: 'rust', modules: ['core'] });
    expect(getAppApiUrl()).toBe('https://weldsuite.example.eu');
    expect(getApiOriginForPath('/api/tickets')).toBe('https://weldsuite.example.eu');
    expect(getApiOrigins()).toEqual(['https://weldsuite.example.eu']);
    expect(getRealtimeUrl()).toBe('wss://weldsuite.example.eu/ws');
  });
});
