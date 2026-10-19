import { describe, expect, it } from 'vitest';
import {
  acceptPreviewSession,
  bridgeOrigins,
  iframeSandbox,
  iframeTargetOrigin,
  ISOLATED_SANDBOX,
  isPreviewAppUrl,
  PREVIEW_SANDBOX,
  R2_SANDBOX,
} from './preview';

describe('WeldApp host preview helpers', () => {
  it('gives R2 bundle URLs a real origin + allow-same-origin (cross-origin from platform)', () => {
    const src = 'https://app-api.weldsuite.org/public/user-apps/demo/index.html';
    expect(isPreviewAppUrl(src)).toBe(false);
    expect(iframeTargetOrigin(src)).toBe('https://app-api.weldsuite.org');
    expect(iframeSandbox()).toBe(R2_SANDBOX);
    expect(iframeSandbox({ kind: 'bundle' })).toBe(R2_SANDBOX);
    expect(R2_SANDBOX).toContain('allow-same-origin');
  });

  it('gives localhost previews a real origin + allow-same-origin', () => {
    const src = 'http://localhost:5173/';
    expect(isPreviewAppUrl(src)).toBe(true);
    expect(isPreviewAppUrl('https://127.0.0.1:5173/')).toBe(true);
    expect(isPreviewAppUrl('http://[::1]:5173/')).toBe(true);
    expect(iframeTargetOrigin(src)).toBe('http://localhost:5173');
    expect(iframeSandbox({ kind: 'preview' })).toBe(PREVIEW_SANDBOX);
  });

  it('returns no origin for an unusable URL', () => {
    expect(iframeTargetOrigin('')).toBeNull();
    expect(iframeTargetOrigin('not a url')).toBeNull();
  });
});

describe('tunnel previews', () => {
  const tunnel = 'https://abc.trycloudflare.com';

  it('are never accepted on the host suffix alone', () => {
    for (const url of [
      tunnel,
      'https://foo.ngrok-free.app/x',
      'https://bar.ngrok.app',
      'https://legacy.ngrok.io',
      'https://preview.pages.dev',
    ]) {
      expect(isPreviewAppUrl(url)).toBe(false);
      expect(isPreviewAppUrl(url, null)).toBe(false);
    }
  });

  it('are accepted only for the exact origin registered on the session', () => {
    expect(isPreviewAppUrl(tunnel, tunnel)).toBe(true);
    expect(isPreviewAppUrl(`${tunnel}/app/index.html`, tunnel)).toBe(true);
    // Another tunnel on the same provider is a different origin.
    expect(isPreviewAppUrl('https://attacker.trycloudflare.com', tunnel)).toBe(false);
    expect(isPreviewAppUrl('https://abc.trycloudflare.com:8443', tunnel)).toBe(false);
    expect(isPreviewAppUrl('http://abc.trycloudflare.com', tunnel)).toBe(false);
    expect(isPreviewAppUrl('https://attacker.ngrok.app', 'https://abc.ngrok.app')).toBe(false);
  });

  it('still need an allowlisted host, even when the registered origin matches', () => {
    expect(isPreviewAppUrl('https://evil.example.com', 'https://evil.example.com')).toBe(false);
    expect(isPreviewAppUrl('https://trycloudflare.com', 'https://trycloudflare.com')).toBe(false);
  });

  it('reject credentials and non-http(s) schemes', () => {
    expect(isPreviewAppUrl('https://user:pass@abc.trycloudflare.com', tunnel)).toBe(false);
    expect(isPreviewAppUrl('https://user@localhost:5173/')).toBe(false);
    expect(isPreviewAppUrl('ftp://localhost:21/')).toBe(false);
    expect(isPreviewAppUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('acceptPreviewSession', () => {
  it('accepts a loopback session', () => {
    expect(acceptPreviewSession({ url: 'http://localhost:5173/', origin: 'http://localhost:5173' })).toEqual({
      url: 'http://localhost:5173/',
      origin: 'http://localhost:5173',
    });
  });

  it('accepts a tunnel session whose registered origin matches the URL', () => {
    expect(
      acceptPreviewSession({ url: 'https://abc.trycloudflare.com/app', origin: 'https://abc.trycloudflare.com' }),
    ).toEqual({ url: 'https://abc.trycloudflare.com/app', origin: 'https://abc.trycloudflare.com' });
  });

  it('rejects a tunnel URL that is not on the registered origin', () => {
    expect(
      acceptPreviewSession({ url: 'https://attacker.ngrok.app/', origin: 'https://abc.trycloudflare.com' }),
    ).toBeNull();
  });

  it('rejects hosts that are not allowlisted, and garbage', () => {
    expect(acceptPreviewSession({ url: 'https://evil.example.com/', origin: 'https://evil.example.com' })).toBeNull();
    expect(acceptPreviewSession({ url: 'not a url' })).toBeNull();
    expect(acceptPreviewSession(null)).toBeNull();
    expect(acceptPreviewSession(undefined)).toBeNull();
  });

  it('tolerates a server that predates the registered origin: loopback only gets in unconditionally', () => {
    expect(acceptPreviewSession({ url: 'http://127.0.0.1:5173/' })).toMatchObject({ origin: 'http://127.0.0.1:5173' });
    // A tunnel still has to be on an allowlisted host.
    expect(acceptPreviewSession({ url: 'https://evil.example.com/' })).toBeNull();
  });
});

describe('sandbox', () => {
  it('drops allow-same-origin only for isolated community bundles', () => {
    expect(ISOLATED_SANDBOX).not.toContain('allow-same-origin');
    expect(ISOLATED_SANDBOX).toContain('allow-scripts');
    expect(iframeSandbox({ kind: 'bundle', isolated: true })).toBe(ISOLATED_SANDBOX);
    // A preview keeps its own real origin: the bridge needs it.
    expect(iframeSandbox({ kind: 'preview', isolated: true })).toBe(PREVIEW_SANDBOX);
  });
});

describe('bridgeOrigins', () => {
  it('pins a normal frame to its exact origin both ways', () => {
    expect(bridgeOrigins('https://app-api.weldsuite.org', false)).toEqual({
      postTarget: 'https://app-api.weldsuite.org',
      eventOrigin: 'https://app-api.weldsuite.org',
    });
  });

  it('reaches an opaque-origin frame with * and expects the null origin back', () => {
    expect(bridgeOrigins('https://app-api.weldsuite.org', true)).toEqual({ postTarget: '*', eventOrigin: 'null' });
  });

  it('has no pin for a frame without an origin: the bridge refuses', () => {
    expect(bridgeOrigins(null, false)).toBeNull();
    expect(bridgeOrigins(null, true)).toBeNull();
  });
});
