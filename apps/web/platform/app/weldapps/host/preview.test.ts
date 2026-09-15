import { describe, expect, it } from 'vitest';
import { iframeSandbox, iframeTargetOrigin, isPreviewAppUrl, PREVIEW_SANDBOX, R2_SANDBOX } from './preview';

describe('WeldApp host preview helpers', () => {
  it('treats R2 bundle URLs as opaque-origin iframes', () => {
    const src = 'https://app-api.weldsuite.org/public/user-apps/demo/index.html';
    expect(isPreviewAppUrl(src)).toBe(false);
    expect(iframeTargetOrigin(src)).toBe('*');
    expect(iframeSandbox(src)).toBe(R2_SANDBOX);
  });

  it('gives localhost and tunnel URLs a real origin + allow-same-origin', () => {
    const src = 'http://localhost:5173/';
    expect(isPreviewAppUrl(src)).toBe(true);
    expect(iframeTargetOrigin(src)).toBe('http://localhost:5173');
    expect(iframeSandbox(src)).toBe(PREVIEW_SANDBOX);
    expect(iframeTargetOrigin('https://abc.trycloudflare.com')).toBe('https://abc.trycloudflare.com');
    expect(isPreviewAppUrl('https://foo.ngrok.io')).toBe(true);
    expect(iframeSandbox('https://foo.ngrok.io')).toBe(PREVIEW_SANDBOX);
  });
});
