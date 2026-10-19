import { describe, expect, it } from 'vitest';
import {
  BUNDLE_LINK_TTL_SECONDS,
  bundleFrameAncestors,
  isBundleHostRequest,
  isDedicatedBundleOrigin,
  isServiceWorkerScriptRequest,
  looksLikeBundleToken,
  plainBundlePath,
  resolveBundleOrigin,
  signBundleCapability,
  signedBundlePath,
  splitBundlePath,
  verifyBundleCapability,
  type BundleEnv,
} from './user-apps-bundle-access';

const env = (overrides: Partial<BundleEnv> = {}): BundleEnv =>
  ({ INTERNAL_API_SECRET: 'internal-secret-for-tests', ...overrides }) as BundleEnv;

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);

async function mint(e: BundleEnv, appId = 'uapp_one', workspaceId = 'ws_one', nowMs = NOW) {
  const minted = await signBundleCapability(e, { appId, workspaceId, nowMs });
  if (!minted) throw new Error('expected a signed link');
  return minted;
}

describe('bundle capability links', () => {
  it('round-trips: valid for the app it was minted for, carrying its workspace', async () => {
    const e = env();
    const { token, expiresAt } = await mint(e);
    expect(looksLikeBundleToken(token)).toBe(true);
    expect(expiresAt.getTime()).toBe(NOW + BUNDLE_LINK_TTL_SECONDS * 1000);

    const verdict = await verifyBundleCapability(e, { appId: 'uapp_one', token, nowMs: NOW + 60_000 });
    expect(verdict).toEqual({ ok: true, workspaceId: 'ws_one', expiresAt: expiresAt.getTime() });
  });

  it('lives 12 hours and not a second longer', async () => {
    const e = env();
    const { token, expiresAt } = await mint(e);
    expect(BUNDLE_LINK_TTL_SECONDS).toBe(12 * 60 * 60);
    const justBefore = await verifyBundleCapability(e, { appId: 'uapp_one', token, nowMs: expiresAt.getTime() - 1000 });
    expect(justBefore.ok).toBe(true);
    const atExpiry = await verifyBundleCapability(e, { appId: 'uapp_one', token, nowMs: expiresAt.getTime() });
    expect(atExpiry).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a link minted for another app', async () => {
    const e = env();
    const { token } = await mint(e, 'uapp_one');
    const verdict = await verifyBundleCapability(e, { appId: 'uapp_two', token, nowMs: NOW });
    expect(verdict).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a link whose workspace was swapped', async () => {
    const e = env();
    const { token } = await mint(e, 'uapp_one', 'ws_one');
    const other = await mint(e, 'uapp_one', 'ws_two');
    const [exp, , signature] = token.split('.');
    const [, otherWorkspace] = other.token.split('.');
    const forged = `${exp}.${otherWorkspace}.${signature}`;
    expect(await verifyBundleCapability(e, { appId: 'uapp_one', token: forged, nowMs: NOW })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a link whose expiry was pushed out', async () => {
    const e = env();
    const { token } = await mint(e);
    const [exp, workspace, signature] = token.split('.');
    const forged = `${Number(exp) + 86_400}.${workspace}.${signature}`;
    expect(await verifyBundleCapability(e, { appId: 'uapp_one', token: forged, nowMs: NOW })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a flipped signature bit and malformed tokens', async () => {
    const e = env();
    const { token } = await mint(e);
    const flipped = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect(await verifyBundleCapability(e, { appId: 'uapp_one', token: flipped, nowMs: NOW })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    for (const bad of ['', 'abc', `${token}.extra`, 'x.y.z', `12345.${'a'.repeat(5)}.short`]) {
      expect(await verifyBundleCapability(e, { appId: 'uapp_one', token: bad, nowMs: NOW })).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('is bound to the signing key: another secret, or a dedicated key, does not verify', async () => {
    const { token } = await mint(env({ INTERNAL_API_SECRET: 'secret-a' }));
    expect(
      await verifyBundleCapability(env({ INTERNAL_API_SECRET: 'secret-b' }), { appId: 'uapp_one', token, nowMs: NOW }),
    ).toEqual({ ok: false, reason: 'bad_signature' });

    const dedicated = env({ USER_APP_BUNDLE_SIGNING_KEY: 'dedicated-key' });
    const minted = await mint(dedicated);
    // The fallback (INTERNAL_API_SECRET) is not accepted once a dedicated key is set.
    expect(
      await verifyBundleCapability(env(), { appId: 'uapp_one', token: minted.token, nowMs: NOW }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
    expect(
      (await verifyBundleCapability(dedicated, { appId: 'uapp_one', token: minted.token, nowMs: NOW })).ok,
    ).toBe(true);
  });

  it('does not sign with the raw secret: a derived key is used', async () => {
    // A signature made with the secret itself as the HMAC key must not verify.
    const secret = 'internal-secret-for-tests';
    const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const exp = Math.floor(NOW / 1000) + 3600;
    const data = new TextEncoder().encode(`uapp-bundle/v1\nuapp_one\nws_one\n${exp}`);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', raw, data));
    const b64 = (bytes: Uint8Array) => btoa(String.fromCodePoint(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const forged = `${exp}.${b64(new TextEncoder().encode('ws_one'))}.${b64(sig)}`;
    expect(await verifyBundleCapability(env(), { appId: 'uapp_one', token: forged, nowMs: NOW })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('fails closed without any signing secret', async () => {
    const bare = {} as BundleEnv;
    expect(await signBundleCapability(bare, { appId: 'uapp_one', workspaceId: 'ws_one' })).toBeNull();
    const { token } = await mint(env());
    expect(await verifyBundleCapability(bare, { appId: 'uapp_one', token, nowMs: NOW })).toEqual({
      ok: false,
      reason: 'unconfigured',
    });
  });

  it('refuses to mint for a workspace id that is not a plain id', async () => {
    expect(await signBundleCapability(env(), { appId: 'uapp_one', workspaceId: 'ws\nx' })).toBeNull();
    expect(await signBundleCapability(env(), { appId: 'uapp_one', workspaceId: '' })).toBeNull();
  });
});

describe('bundle paths', () => {
  it('builds plain and signed paths', () => {
    expect(plainBundlePath('demo')).toBe('/public/user-apps/demo/index.html');
    expect(signedBundlePath('demo', 'TOKEN')).toBe('/public/user-apps/demo/s/TOKEN/index.html');
  });

  it('splits a signed path into token and asset path', async () => {
    const { token } = await mint(env());
    expect(splitBundlePath(`s/${token}/assets/app-abc12345.js`)).toEqual({
      token,
      assetPath: 'assets/app-abc12345.js',
    });
    expect(splitBundlePath(`s/${token}/`)).toEqual({ token, assetPath: '' });
    expect(splitBundlePath(`s/${token}`)).toEqual({ token, assetPath: '' });
    expect(splitBundlePath('assets/app.js')).toEqual({ token: null, assetPath: 'assets/app.js' });
    expect(splitBundlePath('')).toEqual({ token: null, assetPath: '' });
  });

  it("leaves a bundle's own `s/` folder alone", () => {
    expect(splitBundlePath('s/icons/a.png')).toEqual({ token: null, assetPath: 's/icons/a.png' });
    expect(splitBundlePath('s/x.y.z/a.png')).toEqual({ token: null, assetPath: 's/x.y.z/a.png' });
  });
});

describe('bundle origin', () => {
  it('is unset by default: any host serves bundles', () => {
    expect(resolveBundleOrigin({}, 'demo')).toEqual({ status: 'unset' });
    expect(resolveBundleOrigin({ USER_APP_BUNDLE_ORIGIN: '  ' }, 'demo')).toEqual({ status: 'unset' });
    expect(isBundleHostRequest({}, 'demo', 'https://app-api.weldsuite.org')).toBe(true);
  });

  it('serves bundles only on the configured origin', () => {
    const e = { USER_APP_BUNDLE_ORIGIN: 'https://weldappcontent.net' };
    expect(isBundleHostRequest(e, 'demo', 'https://weldappcontent.net')).toBe(true);
    expect(isBundleHostRequest(e, 'demo', 'https://app-api.weldsuite.org')).toBe(false);
    expect(isBundleHostRequest(e, 'demo', 'https://evil.weldappcontent.net')).toBe(false);
  });

  it('supports one origin per app', () => {
    const e = { USER_APP_BUNDLE_ORIGIN: 'https://{code}.weldappcontent.net' };
    expect(resolveBundleOrigin(e, 'demo')).toEqual({ status: 'ok', origin: 'https://demo.weldappcontent.net', perApp: true });
    expect(isBundleHostRequest(e, 'demo', 'https://demo.weldappcontent.net')).toBe(true);
    expect(isBundleHostRequest(e, 'demo', 'https://other.weldappcontent.net')).toBe(false);
    expect(isBundleHostRequest(e, 'demo', 'https://app-api.weldsuite.org')).toBe(false);
  });

  it('fails closed on a configured but unusable value', () => {
    for (const bad of ['not a url', 'http://weldappcontent.net', 'https://weldappcontent.net/path', 'https://u:p@weldappcontent.net', 'ftp://x.test']) {
      const e = { USER_APP_BUNDLE_ORIGIN: bad };
      expect(resolveBundleOrigin(e, 'demo')).toEqual({ status: 'invalid' });
      expect(isBundleHostRequest(e, 'demo', 'https://app-api.weldsuite.org')).toBe(false);
    }
  });

  it('allows plain http only on localhost', () => {
    expect(resolveBundleOrigin({ USER_APP_BUNDLE_ORIGIN: 'http://localhost:8788' }, 'demo')).toEqual({
      status: 'ok',
      origin: 'http://localhost:8788',
      perApp: false,
    });
  });

  it('recognises the dedicated bundle host (for the API-off-bundle-host guard)', () => {
    expect(isDedicatedBundleOrigin({}, 'https://weldappcontent.net')).toBe(false);
    const fixed = { USER_APP_BUNDLE_ORIGIN: 'https://weldappcontent.net' };
    expect(isDedicatedBundleOrigin(fixed, 'https://weldappcontent.net')).toBe(true);
    expect(isDedicatedBundleOrigin(fixed, 'https://app-api.weldsuite.org')).toBe(false);
    const perApp = { USER_APP_BUNDLE_ORIGIN: 'https://{code}.weldappcontent.net' };
    expect(isDedicatedBundleOrigin(perApp, 'https://demo.weldappcontent.net')).toBe(true);
    expect(isDedicatedBundleOrigin(perApp, 'https://demo.weldappcontent.net.evil.test')).toBe(false);
    expect(isDedicatedBundleOrigin(perApp, 'https://app-api.weldsuite.org')).toBe(false);
  });
});

describe('response hardening', () => {
  it('limits framing to the platform origins, never `*`', () => {
    const csp = bundleFrameAncestors({});
    expect(csp.startsWith('frame-ancestors ')).toBe(true);
    expect(csp).not.toMatch(/\s\*(\s|$)/);
    expect(csp).toContain('https://app.weldsuite.org');
    expect(csp).toContain('https://app-test.weldsuite.org');
  });

  it('adds only well-formed extra ancestors', () => {
    const csp = bundleFrameAncestors({
      USER_APP_FRAME_ANCESTORS: 'https://embed.example.com, *, https://*.preview.example.com data: \'self\' javascript:alert(1)',
    });
    expect(csp).toContain('https://embed.example.com');
    expect(csp).toContain('https://*.preview.example.com');
    expect(csp).not.toContain('data:');
    expect(csp).not.toContain("'self'");
    expect(csp).not.toContain('javascript');
    expect(csp).not.toMatch(/\s\*(\s|$)/);
  });

  it('spots a service worker script fetch', () => {
    expect(isServiceWorkerScriptRequest(new Headers({ 'Service-Worker': 'script' }))).toBe(true);
    expect(isServiceWorkerScriptRequest(new Headers())).toBe(false);
  });
});
