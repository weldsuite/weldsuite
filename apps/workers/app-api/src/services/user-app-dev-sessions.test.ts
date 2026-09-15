import { describe, expect, it } from 'vitest';
import { isAllowedDevSessionUrl } from './user-app-dev-sessions';

describe('isAllowedDevSessionUrl', () => {
  it('allows loopback http and https', () => {
    expect(isAllowedDevSessionUrl('http://localhost:5173')).toBe(true);
    expect(isAllowedDevSessionUrl('http://127.0.0.1:5173/')).toBe(true);
    expect(isAllowedDevSessionUrl('https://localhost:5173')).toBe(true);
    expect(isAllowedDevSessionUrl('http://[::1]:5173')).toBe(true);
  });

  it('allows known HTTPS tunnel / preview hosts', () => {
    expect(isAllowedDevSessionUrl('https://abc.trycloudflare.com')).toBe(true);
    expect(isAllowedDevSessionUrl('https://foo.ngrok-free.app/path')).toBe(true);
    expect(isAllowedDevSessionUrl('https://bar.ngrok.app')).toBe(true);
    expect(isAllowedDevSessionUrl('https://legacy.ngrok.io')).toBe(true);
    expect(isAllowedDevSessionUrl('https://preview.pages.dev')).toBe(true);
  });

  it('rejects credentials, non-https remote, and unknown hosts', () => {
    expect(isAllowedDevSessionUrl('not a url')).toBe(false);
    expect(isAllowedDevSessionUrl('https://evil.example.com')).toBe(false);
    expect(isAllowedDevSessionUrl('http://abc.trycloudflare.com')).toBe(false);
    expect(isAllowedDevSessionUrl('https://user:pass@localhost:5173')).toBe(false);
    expect(isAllowedDevSessionUrl('ftp://localhost:21')).toBe(false);
  });
});
