import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SERVER,
  DEVELOPMENT_SERVER,
  type FetchLike,
  checkServer,
  describeRuntimeConfig,
  normaliseServerAddress,
  readStoredServer,
  resolveServer,
  serverFilePath,
  serverHost,
  writeStoredServer,
} from './server';

const EU_CONFIG = {
  auth: {
    provider: 'oidc',
    issuer: 'https://auth.weldsuite.eu',
    clientId: 'weldsuite-web',
    desktopClientId: 'weldsuite-desktop',
  },
  edition: 'eu',
  backend: 'rust',
};

function answer(status: number, body: unknown): FetchLike {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (typeof body === 'string') return JSON.parse(body);
      return body;
    },
  });
}

describe('normaliseServerAddress', () => {
  it('keeps the origin of an https address', () => {
    expect(normaliseServerAddress('https://app.weldsuite.eu')).toBe('https://app.weldsuite.eu');
    expect(normaliseServerAddress('https://weldsuite.example.com/auth/login?x=1')).toBe('https://weldsuite.example.com');
    expect(normaliseServerAddress('https://weldsuite.example.com:8443/')).toBe('https://weldsuite.example.com:8443');
  });

  it('adds https to a bare host name and trims spaces', () => {
    expect(normaliseServerAddress('  weldsuite.example.com ')).toBe('https://weldsuite.example.com');
    expect(normaliseServerAddress('APP.WELDSUITE.EU')).toBe('https://app.weldsuite.eu');
  });

  it('allows http only on a loopback host', () => {
    expect(normaliseServerAddress('http://localhost:3000')).toBe('http://localhost:3000');
    expect(normaliseServerAddress('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(normaliseServerAddress('http://weldsuite.example.com')).toBeNull();
  });

  it('refuses other schemes, credentials and garbage', () => {
    expect(normaliseServerAddress('file:///etc/passwd')).toBeNull();
    expect(normaliseServerAddress('javascript:alert(1)')).toBeNull();
    expect(normaliseServerAddress('ftp://weldsuite.example.com')).toBeNull();
    expect(normaliseServerAddress('https://user:pass@weldsuite.example.com')).toBeNull();
    expect(normaliseServerAddress('https://')).toBeNull();
    expect(normaliseServerAddress('')).toBeNull();
    expect(normaliseServerAddress('   ')).toBeNull();
    expect(normaliseServerAddress(42)).toBeNull();
    expect(normaliseServerAddress(null)).toBeNull();
    expect(normaliseServerAddress(`https://${'a'.repeat(3000)}.eu`)).toBeNull();
  });
});

describe('describeRuntimeConfig', () => {
  it('accepts an OIDC server and reads its edition and desktop client', () => {
    expect(describeRuntimeConfig('https://app.weldsuite.eu', EU_CONFIG)).toEqual({
      status: 'ok',
      origin: 'https://app.weldsuite.eu',
      edition: 'eu',
      browserSignIn: true,
    });
  });

  it('notes a server without a desktop client (sign-in stays in the window)', () => {
    const config = { ...EU_CONFIG, edition: undefined, auth: { ...EU_CONFIG.auth, desktopClientId: null } };
    expect(describeRuntimeConfig('https://weldsuite.example.com', config)).toEqual({
      status: 'ok',
      origin: 'https://weldsuite.example.com',
      edition: null,
      browserSignIn: false,
    });
  });

  it('refuses a Clerk config, a config without an issuer, and non-objects', () => {
    expect(describeRuntimeConfig('https://x.example', { auth: { provider: 'clerk' } }).status).toBe('not_weldsuite');
    expect(describeRuntimeConfig('https://x.example', { auth: { provider: 'oidc' } }).status).toBe('not_weldsuite');
    expect(describeRuntimeConfig('https://x.example', { auth: { provider: 'oidc', issuer: 'http://evil.example' } }).status).toBe('not_weldsuite');
    expect(describeRuntimeConfig('https://x.example', null).status).toBe('not_weldsuite');
    expect(describeRuntimeConfig('https://x.example', 'hello').status).toBe('not_weldsuite');
  });
});

describe('checkServer', () => {
  it('asks the origin for /config.json, without following redirects', async () => {
    const calls: Array<{ url: string; redirect: string }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, redirect: init.redirect });
      return { ok: true, status: 200, json: async () => EU_CONFIG };
    };
    const result = await checkServer('app.weldsuite.eu/some/page', fetchImpl);
    expect(result).toEqual({ status: 'ok', origin: 'https://app.weldsuite.eu', edition: 'eu', browserSignIn: true });
    expect(calls).toEqual([{ url: 'https://app.weldsuite.eu/config.json', redirect: 'error' }]);
  });

  it('calls an invalid address invalid without fetching', async () => {
    let fetched = false;
    const fetchImpl: FetchLike = async () => {
      fetched = true;
      return { ok: true, status: 200, json: async () => EU_CONFIG };
    };
    expect(await checkServer('http://weldsuite.example.com', fetchImpl)).toEqual({ status: 'invalid' });
    expect(fetched).toBe(false);
  });

  it('calls a network error, a redirect or a non-200 answer unreachable', async () => {
    const failing: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await checkServer('weldsuite.example.com', failing)).toEqual({
      status: 'unreachable',
      origin: 'https://weldsuite.example.com',
    });
    expect((await checkServer('weldsuite.example.com', answer(404, {}))).status).toBe('unreachable');
    expect((await checkServer('weldsuite.example.com', answer(502, {}))).status).toBe('unreachable');
  });

  it('times out a server that never answers', async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      });
    expect((await checkServer('weldsuite.example.com', hanging, 20)).status).toBe('unreachable');
  });

  it('refuses Global, whose app answers /config.json with its HTML', async () => {
    expect(await checkServer('app.weldsuite.org', answer(200, '<!DOCTYPE html><html>'))).toEqual({
      status: 'not_weldsuite',
      origin: 'https://app.weldsuite.org',
    });
  });
});

describe('resolveServer', () => {
  it('starts on WeldSuite EU', () => {
    expect(resolveServer({ stored: null, development: false })).toEqual({ url: DEFAULT_SERVER, fromEnvironment: false });
    expect(DEFAULT_SERVER).toBe('https://app.weldsuite.eu');
  });

  it('uses the platform dev server in development', () => {
    expect(resolveServer({ stored: null, development: true })).toEqual({ url: DEVELOPMENT_SERVER, fromEnvironment: false });
  });

  it('prefers the stored choice, and DESKTOP_APP_URL over everything', () => {
    expect(resolveServer({ stored: 'https://weldsuite.example.com', development: false }).url).toBe('https://weldsuite.example.com');
    expect(resolveServer({ environment: 'http://192.168.1.4:3000', stored: 'https://weldsuite.example.com', development: false })).toEqual({
      url: 'http://192.168.1.4:3000',
      fromEnvironment: true,
    });
    expect(resolveServer({ environment: '  ', stored: null, development: false }).url).toBe(DEFAULT_SERVER);
  });

  it('ignores a stored value that is no longer acceptable', () => {
    expect(resolveServer({ stored: 'http://weldsuite.example.com', development: false }).url).toBe(DEFAULT_SERVER);
  });
});

describe('server.json', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('stores, reads and forgets a server', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'weldsuite-server-'));
    const file = serverFilePath(dir);
    expect(readStoredServer(file)).toBeNull();
    await writeStoredServer(file, 'https://weldsuite.example.com');
    expect(readStoredServer(file)).toBe('https://weldsuite.example.com');
    await writeStoredServer(file, null);
    expect(readStoredServer(file)).toBeNull();
    await writeStoredServer(file, null);
  });

  it('reads a broken or hand-edited file as no choice', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'weldsuite-server-'));
    const file = serverFilePath(dir);
    writeFileSync(file, '{ not json');
    expect(readStoredServer(file)).toBeNull();
    writeFileSync(file, JSON.stringify({ url: 'file:///etc/passwd' }));
    expect(readStoredServer(file)).toBeNull();
  });
});

describe('serverHost', () => {
  it('shows the host of a server', () => {
    expect(serverHost('https://app.weldsuite.eu')).toBe('app.weldsuite.eu');
    expect(serverHost('http://localhost:3000')).toBe('localhost:3000');
    expect(serverHost('not a url')).toBe('not a url');
  });
});
