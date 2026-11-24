import { describe, expect, it, vi } from 'vitest';
import { acceptAction, CLICK_DELAY_MS } from '../frames/guard';
import { hostPatternsFor, inspectServer, normaliseServerAddress, profileFromConfig, serverLabel } from './server';
import { isListed, readSettings, withHost } from './settings';

const config = {
  backend: 'rust',
  modules: ['crm', 'pass'],
  auth: {
    provider: 'oidc' as const,
    issuer: 'https://id.example.org/',
    clientId: 'web',
    extensionClientId: 'ext',
    audience: 'weldsuite-api',
    workspaceSource: 'header' as const,
    accountUrl: 'https://id.example.org/account',
  },
};

describe('normaliseServerAddress', () => {
  it('turns what people type into an https origin', () => {
    expect(normaliseServerAddress(' weldsuite.example.com ')).toEqual({ ok: true, origin: 'https://weldsuite.example.com' });
    expect(normaliseServerAddress('https://Weld.Example.com/app/')).toEqual({ ok: true, origin: 'https://weld.example.com' });
    expect(normaliseServerAddress('http://localhost:8080')).toEqual({ ok: true, origin: 'http://localhost:8080' });
  });

  it('refuses plain http, other schemes and nonsense', () => {
    expect(normaliseServerAddress('http://weldsuite.example.com')).toEqual({ ok: false, reason: 'insecure' });
    expect(normaliseServerAddress('ftp://example.com')).toEqual({ ok: false, reason: 'invalid' });
    expect(normaliseServerAddress('https://user:pw@example.com')).toEqual({ ok: false, reason: 'invalid' });
    expect(normaliseServerAddress('weldsuite')).toEqual({ ok: false, reason: 'invalid' });
    expect(normaliseServerAddress('   ')).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('profileFromConfig', () => {
  it('accepts a Rust server with OIDC sign-in, WeldPass and an extension client', () => {
    expect(profileFromConfig('https://eu.example', config)).toEqual({
      ok: true,
      profile: {
        origin: 'https://eu.example',
        apiOrigin: 'https://eu.example',
        issuer: 'https://id.example.org',
        clientId: 'ext',
        audience: 'weldsuite-api',
        orgClaim: null,
        scopes: null,
        audienceScope: undefined,
        organizationScope: undefined,
        workspaceSource: 'header',
        accountUrl: 'https://id.example.org/account',
      },
    });
  });

  it('says why it refuses a server', () => {
    expect(profileFromConfig('https://x', { ...config, backend: undefined })).toEqual({ ok: false, problem: 'not-weldsuite' });
    expect(profileFromConfig('https://x', { ...config, auth: { ...config.auth, extensionClientId: null } })).toEqual({
      ok: false,
      problem: 'no-extension-sign-in',
    });
    expect(profileFromConfig('https://x', { ...config, auth: { provider: 'clerk', publishableKey: 'pk' } })).toEqual({
      ok: false,
      problem: 'no-extension-sign-in',
    });
    expect(profileFromConfig('https://x', { ...config, modules: ['crm'] })).toEqual({ ok: false, problem: 'no-weldpass' });
    // An issuer over plain http (other than localhost) is never used.
    expect(profileFromConfig('https://x', { ...config, auth: { ...config.auth, issuer: 'http://id.example.org' } })).toEqual({
      ok: false,
      problem: 'no-extension-sign-in',
    });
  });

  it('uses the API base URL the server names', () => {
    const result = profileFromConfig('https://x.example', { ...config, apiBaseUrl: 'https://api.x.example/v' });
    expect(result.ok && result.profile.apiOrigin).toBe('https://api.x.example');
  });
});

describe('inspectServer', () => {
  it('reads /config.json without credentials', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(config), { headers: { 'content-type': 'application/json' } }));
    await expect(inspectServer('https://eu.example', fetchImpl as unknown as typeof fetch)).resolves.toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith('https://eu.example/config.json', expect.objectContaining({ credentials: 'omit' }));
  });

  it('tells an unreachable server from one that is not WeldSuite', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const html = vi.fn(async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }));
    await expect(inspectServer('https://x', down as unknown as typeof fetch)).resolves.toEqual({ ok: false, problem: 'unreachable' });
    await expect(inspectServer('https://x', html as unknown as typeof fetch)).resolves.toEqual({ ok: false, problem: 'not-weldsuite' });
  });
});

describe('hostPatternsFor', () => {
  it('builds one pattern per host, without ports, https or localhost only', () => {
    expect(
      hostPatternsFor(['https://app.weldsuite.eu', 'https://app.weldsuite.eu/', 'http://localhost:8080', 'http://evil.example', null]),
    ).toEqual(['https://app.weldsuite.eu/*', 'http://localhost/*']);
    expect(serverLabel('http://localhost:8080')).toBe('localhost:8080');
  });
});

describe('settings', () => {
  it('reads stored settings defensively', () => {
    expect(readSettings(null)).toEqual({ inlineMenus: true, savePrompts: true, neverMenuHosts: [], neverSaveHosts: [] });
    expect(readSettings({ inlineMenus: 'no', neverSaveHosts: ['https://www.Example.com/login', 'not a host', 42] })).toEqual({
      inlineMenus: true,
      savePrompts: true,
      neverMenuHosts: [],
      neverSaveHosts: ['example.com'],
    });
  });

  it('matches a listed host and its subdomains, never a look-alike', () => {
    const list = withHost([], 'example.com');
    expect(isListed('example.com', list)).toBe(true);
    expect(isListed('login.example.com', list)).toBe(true);
    expect(isListed('badexample.com', list)).toBe(false);
    expect(isListed('example.com.evil.test', list)).toBe(false);
  });
});

describe('the click guard', () => {
  it('accepts only trusted clicks on a frame visible for 500 ms', () => {
    expect(acceptAction({ trusted: true, visibleSince: 0, now: CLICK_DELAY_MS })).toBe(true);
    expect(acceptAction({ trusted: true, visibleSince: 0, now: CLICK_DELAY_MS - 1 })).toBe(false);
    expect(acceptAction({ trusted: false, visibleSince: 0, now: 10_000 })).toBe(false);
    expect(acceptAction({ trusted: true, visibleSince: null, now: 10_000 })).toBe(false);
  });
});
