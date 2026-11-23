import { describe, expect, it } from 'vitest';
import { COOKIE, consentCookie, previewCookie, readCookie, serializeCookie, shopCookie } from './cookies';

describe('cookie flags', () => {
  it('makes the shop’s cookies httpOnly and Lax, Secure only over https', () => {
    expect(serializeCookie(COOKIE.cart, 'wct_1', shopCookie(true, { maxAge: 60 }))).toBe('wsf_cart=wct_1; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax');
    expect(serializeCookie(COOKIE.session, 'wss_1', shopCookie(false))).toBe('wsf_session=wss_1; Path=/; HttpOnly; SameSite=Lax');
  });

  it('lets the preview cookie into the editor’s iframe: SameSite=None, Secure, Partitioned', () => {
    const https = serializeCookie(COOKIE.preview, 'tok', previewCookie(true, 'shop.example.com'));
    expect(https).toContain('HttpOnly');
    expect(https).toContain('Secure');
    expect(https).toContain('SameSite=None');
    expect(https).toContain('Partitioned');
  });

  it('uses the secure-context exception for localhost in dev, and Lax over plain http elsewhere', () => {
    expect(previewCookie(false, 'my.shop.localhost')).toMatchObject({ secure: true, sameSite: 'none', partitioned: true });
    const plain = serializeCookie(COOKIE.preview, 'tok', previewCookie(false, 'shop.example.com'));
    expect(plain).not.toContain('Secure');
    expect(plain).not.toContain('Partitioned');
    expect(plain).toContain('SameSite=Lax');
  });

  it('keeps the consent cookie readable by page script', () => {
    const consent = serializeCookie(COOKIE.consent, 'granted', consentCookie(true));
    expect(consent).not.toContain('HttpOnly');
    expect(consent).toContain('Secure');
    expect(consent).toContain('Max-Age=15552000');
  });

  it('reads one cookie from a header', () => {
    expect(readCookie('a=1; wsf_preview=abc%3D; b=2', COOKIE.preview)).toBe('abc=');
    expect(readCookie('wsf_previewx=1', COOKIE.preview)).toBeUndefined();
    expect(readCookie(null, COOKIE.preview)).toBeUndefined();
  });
});
