import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '@weldsuite/app-api-client/schemas/runtime-config';
import { hostOf, normaliseServerAddress } from './address';
import { buildGlobalRuntime, buildServerRuntime, globalPersonalApiOrigin } from './build';
import { assessServerConfig, fetchServerConfig } from './server-config';
import {
  readServerChoice,
  resolveMobileRuntime,
  saveServerChoice,
  SERVER_CHOICE_KEY,
  type KeyValueStore,
} from './state';
import { onClearServerData, onLeaveServer, performServerSwitch, resetServerSwitchRegistry } from './switch';
import type { MobileAppIdentity, MobileBuildEnv } from './types';

const APP: MobileAppIdentity = { code: 'weldmail', name: 'WeldMail', requiredModules: ['mail'] };

const BUILD: MobileBuildEnv = {
  appApiUrl: 'https://app-api-test.weldsuite.org',
  apiModules: 'all',
  personalApiUrl: 'https://personal-api-test.weldsuite.org',
  realtimeUrl: 'wss://realtime-test.weldsuite.org',
  clerkPublishableKey: 'pk_test_abc',
  euServerUrl: 'https://app.test.weldsuite.eu',
  serverPicker: 'on',
};

const EU_CONFIG: RuntimeConfig = {
  backend: 'rust',
  version: '0.1.0',
  edition: 'eu',
  modules: ['core', 'mail', 'chat'],
  unavailableFeatures: ['billing', 'mail-ai'],
  realtimeUrl: 'wss://app.test.weldsuite.eu/ws',
  auth: {
    provider: 'oidc',
    issuer: 'https://auth.test.weldsuite.eu',
    clientId: 'web-client',
    mobileClientId: 'mobile-client',
    audience: 'project',
    orgClaim: 'urn:zitadel:iam:org:project:project:roles',
  },
};

function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
    },
  };
}

function jsonResponse(body: unknown, init: { status?: number; contentType?: string } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': init.contentType ?? 'application/json' },
  });
}

describe('normaliseServerAddress', () => {
  it('adds https and keeps only the origin', () => {
    expect(normaliseServerAddress(' Weld.Example.com/app?x=1 ')).toEqual({ ok: true, origin: 'https://weld.example.com' });
    expect(normaliseServerAddress('https://weld.example.com:8443/')).toEqual({ ok: true, origin: 'https://weld.example.com:8443' });
    expect(normaliseServerAddress('https://weld.example.com:443')).toEqual({ ok: true, origin: 'https://weld.example.com' });
  });

  it('refuses http unless allowed, and anything that is not a host', () => {
    expect(normaliseServerAddress('http://weld.example.com')).toEqual({ ok: false, reason: 'insecure' });
    expect(normaliseServerAddress('http://192.168.1.20:8080', { allowInsecure: true })).toEqual({
      ok: true,
      origin: 'http://192.168.1.20:8080',
    });
    expect(normaliseServerAddress('')).toEqual({ ok: false, reason: 'empty' });
    expect(normaliseServerAddress('ftp://weld.example.com')).toEqual({ ok: false, reason: 'invalid' });
    expect(normaliseServerAddress('https://user@weld.example.com')).toEqual({ ok: false, reason: 'invalid' });
    expect(normaliseServerAddress('not a host')).toEqual({ ok: false, reason: 'invalid' });
    expect(normaliseServerAddress('https://weld.example.com:99999')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('shows the host', () => {
    expect(hostOf('https://weld.example.com:8443')).toBe('weld.example.com:8443');
  });
});

describe('buildGlobalRuntime', () => {
  it('uses the build values, as before the server choice', () => {
    const runtime = buildGlobalRuntime(APP, BUILD);
    expect(runtime.edition).toBe('global');
    expect(runtime.apiOrigin).toBe('https://app-api-test.weldsuite.org');
    expect(runtime.apiModules.has('mail')).toBe(true);
    expect(runtime.personalApiOrigin).toBe('https://personal-api-test.weldsuite.org');
    expect(runtime.platformUrl).toBe('https://app-test.weldsuite.org');
    expect(runtime.auth).toEqual({ provider: 'clerk', publishableKey: 'pk_test_abc' });
    expect(runtime.modules).toBe('all');
    expect(runtime.pushEnabled).toBe(true);
    expect(runtime.serverPickerEnabled).toBe(true);
    expect(runtime.euOrigin).toBe('https://app.test.weldsuite.eu');
  });

  it('pairs personal-api with the app-api host', () => {
    expect(globalPersonalApiOrigin({ appApiUrl: 'https://app-api.weldsuite.org/', personalApiUrl: 'https://wrong' })).toBe(
      'https://personal-api.weldsuite.org',
    );
    expect(globalPersonalApiOrigin({ personalApiUrl: 'http://10.0.2.2:8787/' })).toBe('http://10.0.2.2:8787');
  });

  it('keeps the picker off unless the build says on', () => {
    expect(buildGlobalRuntime(APP, { ...BUILD, serverPicker: undefined }).serverPickerEnabled).toBe(false);
  });
});

describe('buildServerRuntime', () => {
  it('sends everything to one origin and signs in with the mobile client', () => {
    const runtime = buildServerRuntime(APP, BUILD, { kind: 'eu', origin: 'https://app.test.weldsuite.eu' }, EU_CONFIG);
    expect(runtime.edition).toBe('eu');
    expect(runtime.apiOrigin).toBe('https://app.test.weldsuite.eu');
    expect(runtime.apiModules.size).toBe(0);
    expect(runtime.personalApiOrigin).toBe('https://app.test.weldsuite.eu/personal-api');
    expect(runtime.realtimeUrl).toBe('wss://app.test.weldsuite.eu');
    expect(runtime.auth).toMatchObject({ provider: 'oidc', clientId: 'mobile-client', audience: 'project' });
    expect(runtime.unavailableFeatures.has('mail-ai')).toBe(true);
    expect(runtime.modules).toEqual(new Set(['core', 'mail', 'chat']));
    expect(runtime.pushEnabled).toBe(false);
  });
});

describe('assessServerConfig', () => {
  it('needs a mobile client and the app module', () => {
    expect(assessServerConfig(EU_CONFIG, APP)).toBeNull();
    expect(assessServerConfig({ ...EU_CONFIG, auth: undefined }, APP)).toBe('no-mobile-sign-in');
    expect(
      assessServerConfig({ ...EU_CONFIG, auth: { provider: 'oidc', issuer: 'https://auth.example', mobileClientId: null } }, APP),
    ).toBe('no-mobile-sign-in');
    expect(assessServerConfig(EU_CONFIG, { ...APP, requiredModules: ['agent'] })).toBe('app-unavailable');
    expect(assessServerConfig(EU_CONFIG, { ...APP, supportsServer: (c) => c.videoProvider !== 'livekit' })).toBeNull();
    expect(
      assessServerConfig({ ...EU_CONFIG, videoProvider: 'livekit' }, { ...APP, supportsServer: (c) => c.videoProvider !== 'livekit' }),
    ).toBe('app-unavailable');
  });
});

describe('fetchServerConfig', () => {
  it('accepts a Rust config.json', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(EU_CONFIG));
    await expect(fetchServerConfig('https://app.test.weldsuite.eu', { fetchImpl })).resolves.toEqual({
      ok: true,
      config: EU_CONFIG,
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://app.test.weldsuite.eu/config.json', expect.anything());
  });

  it('tells an unreachable server from one that is not WeldSuite', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('Network request failed');
    });
    await expect(fetchServerConfig('https://x.example', { fetchImpl: down })).resolves.toEqual({ ok: false, problem: 'unreachable' });
    const html = vi.fn(async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }));
    await expect(fetchServerConfig('https://x.example', { fetchImpl: html })).resolves.toEqual({ ok: false, problem: 'not-weldsuite' });
    const global = vi.fn(async () => jsonResponse({ backend: 'workers' }));
    await expect(fetchServerConfig('https://x.example', { fetchImpl: global })).resolves.toEqual({ ok: false, problem: 'not-weldsuite' });
    const missing = vi.fn(async () => jsonResponse({}, { status: 404 }));
    await expect(fetchServerConfig('https://x.example', { fetchImpl: missing })).resolves.toEqual({ ok: false, problem: 'not-weldsuite' });
  });
});

describe('server choice storage', () => {
  it('round-trips and keeps EU on the build’s origin', async () => {
    const store = memoryStore();
    await saveServerChoice(store, { kind: 'eu', origin: 'https://ignored.example' });
    expect(JSON.parse(store.data.get(SERVER_CHOICE_KEY) ?? '')).toEqual({ kind: 'eu' });
    await saveServerChoice(store, { kind: 'self-hosted', origin: 'https://weld.example.com' });
    await expect(readServerChoice(store)).resolves.toEqual({ kind: 'self-hosted', origin: 'https://weld.example.com' });
    await saveServerChoice(store, { kind: 'global' });
    expect(store.data.has(SERVER_CHOICE_KEY)).toBe(false);
  });

  it('ignores a damaged entry', async () => {
    await expect(readServerChoice(memoryStore({ [SERVER_CHOICE_KEY]: '{nope' }))).resolves.toBeNull();
    await expect(readServerChoice(memoryStore({ [SERVER_CHOICE_KEY]: '{"kind":"mars"}' }))).resolves.toBeNull();
  });
});

describe('resolveMobileRuntime', () => {
  it('is Global without a saved choice, without a request', async () => {
    const fetchImpl = vi.fn();
    const result = await resolveMobileRuntime({ app: APP, build: BUILD, store: memoryStore(), fetchImpl });
    expect(result.status === 'ready' && result.runtime.edition).toBe('global');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is Global when the build has the picker off, whatever was saved', async () => {
    const store = memoryStore({ [SERVER_CHOICE_KEY]: '{"kind":"eu"}' });
    const result = await resolveMobileRuntime({ app: APP, build: { ...BUILD, serverPicker: 'off' }, store, fetchImpl: vi.fn() });
    expect(result.status === 'ready' && result.runtime.edition).toBe('global');
  });

  it('describes EU from its config.json and caches it', async () => {
    const store = memoryStore({ [SERVER_CHOICE_KEY]: '{"kind":"eu"}' });
    const fetchImpl = vi.fn(async () => jsonResponse(EU_CONFIG));
    const result = await resolveMobileRuntime({ app: APP, build: BUILD, store, fetchImpl });
    expect(result.status).toBe('ready');
    expect(result.status === 'ready' && result.runtime.apiOrigin).toBe('https://app.test.weldsuite.eu');
    expect(store.data.has('weldsuite:server-config:https://app.test.weldsuite.eu')).toBe(true);
  });

  it('starts from the cached config and refreshes it in the background', async () => {
    const store = memoryStore({
      [SERVER_CHOICE_KEY]: '{"kind":"eu"}',
      'weldsuite:server-config:https://app.test.weldsuite.eu': JSON.stringify(EU_CONFIG),
    });
    const onRefreshed = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse({ ...EU_CONFIG, version: '0.2.0' }));
    const result = await resolveMobileRuntime({ app: APP, build: BUILD, store, fetchImpl, onRefreshed });
    expect(result.status === 'ready' && result.runtime.version).toBe('0.1.0');
    await vi.waitFor(() => expect(onRefreshed).toHaveBeenCalled());
    expect(JSON.parse(store.data.get('weldsuite:server-config:https://app.test.weldsuite.eu') ?? '').version).toBe('0.2.0');
  });

  it('fails when an unseen server is unreachable or not usable', async () => {
    const store = memoryStore({ [SERVER_CHOICE_KEY]: '{"kind":"self-hosted","origin":"https://weld.example.com"}' });
    const down = vi.fn(async () => {
      throw new TypeError('offline');
    });
    await expect(resolveMobileRuntime({ app: APP, build: BUILD, store, fetchImpl: down })).resolves.toMatchObject({
      status: 'failed',
      problem: 'unreachable',
      choice: { kind: 'self-hosted', origin: 'https://weld.example.com' },
    });
    const noMail = vi.fn(async () => jsonResponse({ ...EU_CONFIG, modules: ['core'] }));
    await expect(resolveMobileRuntime({ app: APP, build: BUILD, store: memoryStore(Object.fromEntries(store.data)), fetchImpl: noMail })).resolves.toMatchObject({
      status: 'failed',
      problem: 'app-unavailable',
    });
  });

  it('falls back to Global when the build has no EU server', async () => {
    const store = memoryStore({ [SERVER_CHOICE_KEY]: '{"kind":"eu"}' });
    const result = await resolveMobileRuntime({ app: APP, build: { ...BUILD, euServerUrl: undefined }, store, fetchImpl: vi.fn() });
    expect(result.status === 'ready' && result.runtime.edition).toBe('global');
  });
});

describe('performServerSwitch', () => {
  it('leaves, signs out, clears, saves and reloads, in that order, past failures', async () => {
    resetServerSwitchRegistry();
    const order: string[] = [];
    const store = memoryStore();
    onLeaveServer('push', async () => {
      order.push('leave');
      throw new Error('offline');
    });
    onClearServerData('cache', () => {
      order.push('clear');
    });
    await performServerSwitch(
      { kind: 'self-hosted', origin: 'https://weld.example.com' },
      {
        store,
        runtime: buildGlobalRuntime(APP, BUILD),
        signOut: async () => {
          order.push('signOut');
        },
        reload: async () => {
          order.push(`reload:${store.data.get(SERVER_CHOICE_KEY)}`);
        },
      },
    );
    expect(order).toEqual(['leave', 'signOut', 'clear', 'reload:{"kind":"self-hosted","origin":"https://weld.example.com"}']);
  });

  it('skips the leave tasks when the app never booted', async () => {
    resetServerSwitchRegistry();
    const leave = vi.fn();
    onLeaveServer('push', leave);
    await performServerSwitch({ kind: 'global' }, { store: memoryStore(), runtime: null, signOut: async () => {}, reload: async () => {} });
    expect(leave).not.toHaveBeenCalled();
  });
});
