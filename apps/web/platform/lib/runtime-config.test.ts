import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchRuntimeConfig,
  getRuntimeConfig,
  isRuntimeConfigEnabled,
  isRuntimeEnv,
  isRustBackend,
  loadRuntimeConfig,
  parseRuntimeConfig,
  publicEnv,
  setRuntimeConfig,
} from './runtime-config';

function response(body: string, init: { status?: number; contentType?: string } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': init.contentType ?? 'application/json' },
  });
}

const rustConfig = {
  backend: 'rust',
  version: '0.1.0',
  modules: ['core', 'know'],
};

afterEach(() => {
  setRuntimeConfig(null);
  vi.unstubAllEnvs();
});

describe('fetchRuntimeConfig', () => {
  it('reads what the Rust backend serves', async () => {
    const fetchImpl = vi.fn(async () => response(JSON.stringify(rustConfig)));
    await expect(fetchRuntimeConfig(fetchImpl)).resolves.toEqual(rustConfig);
    expect(fetchImpl).toHaveBeenCalledWith('/config.json', expect.objectContaining({ cache: 'no-store' }));
  });

  it("ignores Pages' SPA fallback (index.html with a 200)", async () => {
    const fetchImpl = vi.fn(async () => response('<!DOCTYPE html><html></html>', { contentType: 'text/html' }));
    await expect(fetchRuntimeConfig(fetchImpl)).resolves.toBeNull();
  });

  it('falls back on a 404, a network error and invalid JSON', async () => {
    await expect(fetchRuntimeConfig(async () => response('{}', { status: 404 }))).resolves.toBeNull();
    await expect(
      fetchRuntimeConfig(async () => {
        throw new TypeError('Failed to fetch');
      }),
    ).resolves.toBeNull();
    await expect(fetchRuntimeConfig(async () => response('{not json'))).resolves.toBeNull();
  });

  it('falls back on a document that breaks the contract', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bad = { auth: { provider: 'oidc', issuer: 'not a url', clientId: 'x' } };
    await expect(fetchRuntimeConfig(async () => response(JSON.stringify(bad)))).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('gives up on a slow answer', async () => {
    const fetchImpl = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    await expect(fetchRuntimeConfig(fetchImpl, 10)).resolves.toBeNull();
  });
});

describe('loadRuntimeConfig with VITE_RUNTIME_CONFIG=on (Kubernetes builds)', () => {
  it('keeps the document for later readers', async () => {
    vi.stubEnv('VITE_RUNTIME_CONFIG', 'on');
    expect(isRuntimeConfigEnabled()).toBe(true);
    await loadRuntimeConfig(async () => response(JSON.stringify(rustConfig)));
    expect(getRuntimeConfig()?.modules).toEqual(['core', 'know']);
    expect(isRustBackend()).toBe(true);
  });

  it('falls back to the build-time settings when there is none', async () => {
    vi.stubEnv('VITE_RUNTIME_CONFIG', 'on');
    await loadRuntimeConfig(async () => response('', { status: 404 }));
    expect(getRuntimeConfig()).toBeNull();
    expect(isRustBackend()).toBe(false);
  });
});

describe('loadRuntimeConfig with the switch unset or off (Global)', () => {
  it.each([undefined, '', 'off', 'true'])('requests nothing for %s', async (value) => {
    if (value !== undefined) vi.stubEnv('VITE_RUNTIME_CONFIG', value);
    const fetchImpl = vi.fn(async () => response(JSON.stringify(rustConfig)));
    await expect(loadRuntimeConfig(fetchImpl)).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(isRuntimeConfigEnabled()).toBe(false);
    expect(getRuntimeConfig()).toBeNull();
  });
});

describe('parseRuntimeConfig', () => {
  it('accepts the OIDC auth block the backend serves and ignores unknown fields', () => {
    // What `config_json` serves with AUTH_PROVIDER=oidc (rust/bins/weldsuite/src/main.rs).
    const auth = {
      provider: 'oidc',
      issuer: 'https://id.example.eu',
      clientId: '300000000000000300',
      audience: '300000000000000100',
      orgClaim: 'urn:zitadel:iam:org:project:300000000000000100:roles',
    };
    const config = parseRuntimeConfig({ backend: 'rust', version: '0.1.0', modules: ['core'], future: true, auth });
    expect(config?.auth).toEqual(auth);
  });

  it('keeps the edition and the features the backend lacks (4.F3)', () => {
    const config = parseRuntimeConfig({
      backend: 'rust',
      edition: 'eu',
      modules: ['core', 'know'],
      unavailableFeatures: ['billing', 'sso-connections'],
    });
    expect(config?.edition).toBe('eu');
    expect(config?.unavailableFeatures).toEqual(['billing', 'sso-connections']);
  });

  it('keeps an OIDC block whose clientId the backend left unset', () => {
    const config = parseRuntimeConfig({ auth: { provider: 'oidc', issuer: 'https://id.example.eu', clientId: null } });
    expect(config?.auth?.provider).toBe('oidc');
  });
});

describe('publicEnv', () => {
  it('uses the build-time value without a runtime config', () => {
    vi.stubEnv('VITE_MAPBOX_ACCESS_TOKEN', 'pk.build');
    expect(publicEnv('VITE_MAPBOX_ACCESS_TOKEN')).toBe('pk.build');
    expect(isRuntimeEnv('VITE_MAPBOX_ACCESS_TOKEN')).toBe(false);
  });

  it('treats an empty build-time value as unset', () => {
    vi.stubEnv('VITE_MAPBOX_ACCESS_TOKEN', '');
    expect(publicEnv('VITE_MAPBOX_ACCESS_TOKEN')).toBeUndefined();
  });

  it('prefers the runtime env map and the structured fields', () => {
    vi.stubEnv('VITE_MAPBOX_ACCESS_TOKEN', 'pk.build');
    vi.stubEnv('VITE_APP_API_URL', 'https://app-api.weldsuite.org');
    vi.stubEnv('VITE_CLERK_PUBLISHABLE_KEY', 'pk_live_build');
    setRuntimeConfig({
      apiBaseUrl: 'https://weldsuite.example.eu',
      auth: { provider: 'clerk', publishableKey: 'pk_live_runtime' },
      env: { VITE_MAPBOX_ACCESS_TOKEN: 'pk.runtime' },
    });
    expect(publicEnv('VITE_MAPBOX_ACCESS_TOKEN')).toBe('pk.runtime');
    expect(publicEnv('VITE_APP_API_URL')).toBe('https://weldsuite.example.eu');
    expect(publicEnv('VITE_CLERK_PUBLISHABLE_KEY')).toBe('pk_live_runtime');
    expect(isRuntimeEnv('VITE_APP_API_URL')).toBe(true);
  });
});
