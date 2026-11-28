import { describe, it, expect, afterEach, vi } from 'vitest';
import { apiUrl, getAppApiUrl, getRealtimeUrl, getRealtimeWsOrigin } from './public-env';
import { setRuntimeConfig } from '@/lib/runtime-config';

function stubLocation(origin: string) {
  const url = new URL(origin);
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, hostname: url.hostname, origin: url.origin },
  });
}

describe('getAppApiUrl without a runtime config', () => {
  const originalLocation = window.location;

  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('uses the build-time URL when the SPA is on localhost', () => {
    stubLocation('http://localhost:3000');
    vi.stubEnv('VITE_APP_API_URL', 'http://localhost:9000');
    expect(getAppApiUrl()).toBe('http://localhost:9000');
  });

  it('defaults to the local weldsuite serve', () => {
    stubLocation('http://localhost:3000');
    vi.stubEnv('VITE_APP_API_URL', '');
    expect(getAppApiUrl()).toBe('http://localhost:8080');
  });

  it('ignores a leaked localhost env URL on a hosted SPA and uses its own origin', () => {
    stubLocation('https://weldsuite.example.eu');
    vi.stubEnv('VITE_APP_API_URL', 'http://localhost:8080');
    expect(getAppApiUrl()).toBe('https://weldsuite.example.eu');
  });

  it('keeps an explicit non-local env URL on a hosted SPA', () => {
    stubLocation('https://weldsuite.example.eu');
    vi.stubEnv('VITE_APP_API_URL', 'https://api.example.eu/');
    expect(getAppApiUrl()).toBe('https://api.example.eu');
    expect(apiUrl('/api/weldpass/projects')).toBe('https://api.example.eu/api/weldpass/projects');
  });
});

describe('getRealtimeUrl without a runtime config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to the local weldsuite serve', () => {
    stubLocation('http://localhost:3000');
    vi.stubEnv('VITE_REALTIME_URL', '');
    expect(getRealtimeUrl()).toBe('ws://localhost:8080/ws');
  });

  it('turns realtime off for a leaked localhost URL on a hosted SPA', () => {
    stubLocation('https://weldsuite.example.eu');
    vi.stubEnv('VITE_REALTIME_URL', 'ws://localhost:8080/ws');
    expect(getRealtimeUrl()).toBe('');
  });
});

describe('runtime config (/config.json)', () => {
  afterEach(() => {
    setRuntimeConfig(null);
    vi.unstubAllEnvs();
  });

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

  it('sends every path to the SPA origin when it names no API origin', () => {
    stubLocation('https://weldsuite.example.eu');
    vi.stubEnv('VITE_APP_API_URL', 'https://elsewhere.example.eu');
    setRuntimeConfig({ backend: 'rust', modules: ['core'] });
    expect(getAppApiUrl()).toBe('https://weldsuite.example.eu');
    expect(apiUrl('/api/tickets')).toBe('https://weldsuite.example.eu/api/tickets');
    // No realtimeUrl in /config.json: realtime is off, not a guessed ${origin}/ws.
    expect(getRealtimeUrl()).toBe('');
    expect(getRealtimeWsOrigin()).toBe('');
  });

  it('uses the realtime URL of /config.json, and its origin for rooms', () => {
    stubLocation('https://weldsuite.example.eu');
    setRuntimeConfig({ backend: 'rust', modules: ['core'], realtimeUrl: 'wss://rt.example.eu/ws' });
    expect(getRealtimeUrl()).toBe('wss://rt.example.eu/ws');
    expect(getRealtimeWsOrigin()).toBe('wss://rt.example.eu');
  });
});
