/**
 * Both boot modes (`./mode.ts`): Global renders without asking for
 * `/config.json`; the Kubernetes boot reads it first, picks the identity
 * provider, and only then imports the app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootMode, isRuntimeConfigOn } from './mode';

const calls = vi.hoisted(() => ({ order: [] as string[] }));

vi.mock('../app', () => ({
  renderApp: vi.fn(() => calls.order.push('render')),
}));
vi.mock('@weldsuite/i18n/locales', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/i18n/locales')>()),
  loadLocale: vi.fn(async () => {
    calls.order.push('locale');
  }),
}));
vi.mock('@/lib/auth/oidc', () => ({
  createOidcAuth: vi.fn(() => ({ provider: 'oidc' })),
}));
vi.mock('@/lib/auth', () => ({
  setAuthImplementation: vi.fn(),
}));

import { renderApp } from '../app';
import { setAuthImplementation } from '@/lib/auth';
import { createOidcAuth } from '@/lib/auth/oidc';
import { setRuntimeConfig } from '@/lib/runtime-config';
import { startApp as startGlobal } from './global';
import { startApp as startRuntime } from './runtime';

let fetchMock: ReturnType<typeof vi.fn>;

function serve(body: unknown) {
  fetchMock.mockImplementation(async () => {
    calls.order.push('config');
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  });
}

beforeEach(() => {
  calls.order = [];
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  setRuntimeConfig(null);
});

describe('the switch', () => {
  it('is on only for "on"', () => {
    expect(isRuntimeConfigOn('on')).toBe(true);
    expect(isRuntimeConfigOn(' ON ')).toBe(true);
    for (const value of [undefined, null, '', 'off', 'true', '1']) expect(isRuntimeConfigOn(value)).toBe(false);
  });

  it('picks the boot file vite.config.ts aliases @boot to', () => {
    expect(bootMode(undefined)).toBe('global');
    expect(bootMode('off')).toBe('global');
    expect(bootMode('on')).toBe('runtime');
  });
});

describe('Global boot (switch unset or off)', () => {
  it('renders after the locale without requesting /config.json', async () => {
    await startGlobal();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls.order).toEqual(['locale', 'render']);
  });
});

describe('Kubernetes boot (VITE_RUNTIME_CONFIG=on)', () => {
  beforeEach(() => vi.stubEnv('VITE_RUNTIME_CONFIG', 'on'));

  it('reads /config.json before importing and rendering the app', async () => {
    serve({ backend: 'rust', modules: ['core'] });
    await startRuntime();
    expect(fetchMock).toHaveBeenCalledWith('/config.json', expect.anything());
    expect(calls.order.indexOf('config')).toBeLessThan(calls.order.indexOf('render'));
    expect(renderApp).toHaveBeenCalledTimes(1);
    expect(setAuthImplementation).not.toHaveBeenCalled();
  });

  it('switches to OIDC when the backend names it', async () => {
    const auth = { provider: 'oidc', issuer: 'https://id.example.eu', clientId: '300', orgClaim: 'roles' };
    serve({ backend: 'rust', auth });
    await startRuntime();
    expect(createOidcAuth).toHaveBeenCalledWith(auth);
    expect(setAuthImplementation).toHaveBeenCalledWith({ provider: 'oidc' });
  });

  it('stays on Clerk when the OIDC block has no client id', async () => {
    serve({ auth: { provider: 'oidc', issuer: 'https://id.example.eu', clientId: null } });
    await startRuntime();
    expect(setAuthImplementation).not.toHaveBeenCalled();
    expect(renderApp).toHaveBeenCalledTimes(1);
  });

  it('still renders when /config.json is missing', async () => {
    fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));
    await startRuntime();
    expect(renderApp).toHaveBeenCalledTimes(1);
  });
});
