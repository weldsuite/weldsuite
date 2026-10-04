import { describe, expect, it } from 'vitest';
import { evaluateFill, pageContext } from './fill-policy';

describe('pageContext', () => {
  it('accepts https pages', () => {
    expect(pageContext('https://www.example.com/login?next=/')).toEqual({
      ok: true,
      origin: 'https://www.example.com',
      host: 'example.com',
    });
  });

  it('accepts http only on localhost', () => {
    expect(pageContext('http://localhost:3000/sign-in')).toEqual({
      ok: true,
      origin: 'http://localhost:3000',
      host: 'localhost',
    });
    expect(pageContext('http://example.com/login')).toEqual({ ok: false, reason: 'insecure-page' });
    expect(pageContext('http://localhost.evil.example/')).toEqual({
      ok: false,
      reason: 'insecure-page',
    });
    expect(pageContext('http://127.0.0.1:8080/')).toEqual({ ok: false, reason: 'insecure-page' });
  });

  it.each([
    'chrome://extensions',
    'chrome-extension://abcdefghijklmnop/popup.html',
    'about:blank',
    'file:///C:/Users/ada/passwords.html',
    'data:text/html,<input type=password>',
    'javascript:alert(1)',
    'not a url',
  ])('refuses %s', (url) => {
    expect(pageContext(url)).toEqual({ ok: false, reason: 'unsupported-page' });
  });

  it('refuses a tab without a URL (no activeTab grant)', () => {
    expect(pageContext(undefined)).toEqual({ ok: false, reason: 'no-page' });
    expect(pageContext(null)).toEqual({ ok: false, reason: 'no-page' });
    expect(pageContext('')).toEqual({ ok: false, reason: 'no-page' });
  });
});

describe('evaluateFill', () => {
  it('allows a login on its own host', () => {
    expect(evaluateFill({ host: 'example.com' }, 'https://example.com/login')).toEqual({
      ok: true,
      origin: 'https://example.com',
    });
  });

  it('allows a subdomain in either direction, as the shared hostsMatch does', () => {
    expect(evaluateFill({ host: 'example.com' }, 'https://accounts.example.com/').ok).toBe(true);
    expect(evaluateFill({ host: 'accounts.example.com' }, 'https://example.com/').ok).toBe(true);
  });

  it.each([
    ['a different site', 'example.com', 'https://evil.example/'],
    ['a look-alike suffix', 'example.com', 'https://notexample.com/'],
    ['a host that merely contains the name', 'example.com', 'https://example.com.evil.example/'],
    ['a sibling under a bare TLD', 'example.co.uk', 'https://other.co.uk/'],
  ])('refuses %s', (_name, host, url) => {
    expect(evaluateFill({ host }, url)).toEqual({ ok: false, reason: 'host-mismatch' });
  });

  it('refuses a matching host on plain http', () => {
    expect(evaluateFill({ host: 'example.com' }, 'http://example.com/login')).toEqual({
      ok: false,
      reason: 'insecure-page',
    });
  });

  it('allows a localhost login on http://localhost', () => {
    expect(evaluateFill({ host: 'localhost' }, 'http://localhost:5173/')).toEqual({
      ok: true,
      origin: 'http://localhost:5173',
    });
  });

  it('refuses a login saved without a site', () => {
    expect(evaluateFill({ host: null }, 'https://example.com/')).toEqual({
      ok: false,
      reason: 'no-item-host',
    });
  });

  it('refuses when the tab has no URL', () => {
    expect(evaluateFill({ host: 'example.com' }, null)).toEqual({ ok: false, reason: 'no-page' });
  });
});
