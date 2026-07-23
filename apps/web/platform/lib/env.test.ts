import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getEnv, getAllEnv } from './env';

declare global {
  interface Window {
    __ENV?: Record<string, string>;
  }
}

describe('getEnv', () => {
  const originalEnv = { ...window };

  beforeEach(() => {
    delete window.__ENV;
  });

  afterEach(() => {
    delete window.__ENV;
    vi.unstubAllEnvs();
  });

  it('returns the value from window.__ENV when present (Docker runtime)', () => {
    window.__ENV = { VITE_API_BASE_URL: 'https://runtime.example' };
    expect(getEnv('VITE_API_BASE_URL')).toBe('https://runtime.example');
  });

  it('falls back to import.meta.env when window.__ENV is absent', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://meta.example');
    expect(getEnv('VITE_API_BASE_URL')).toBe('https://meta.example');
  });

  it('returns empty string when neither source has the variable', () => {
    expect(getEnv('VITE_BETTERSTACK_SOURCE_TOKEN')).toBe('');
  });

  it('window.__ENV takes precedence over import.meta.env', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://meta.example');
    window.__ENV = { VITE_API_BASE_URL: 'https://runtime.example' };
    expect(getEnv('VITE_API_BASE_URL')).toBe('https://runtime.example');
  });
});

describe('getAllEnv', () => {
  beforeEach(() => {
    delete window.__ENV;
  });

  it('returns window.__ENV verbatim when present', () => {
    const fake = { VITE_API_BASE_URL: 'https://x', VITE_MIXPANEL_TOKEN: 'tok' };
    window.__ENV = fake;
    expect(getAllEnv()).toEqual(fake);
  });

  it('returns a snapshot from import.meta.env when window.__ENV is missing', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://meta');
    const all = getAllEnv();
    expect(all.VITE_API_BASE_URL).toBe('https://meta');
    // Keys we didn't stub are still present (undefined or empty); the
    // shape contract is what we care about.
    expect(all).toHaveProperty('VITE_CLERK_PUBLISHABLE_KEY');
    expect(all).toHaveProperty('VITE_MIXPANEL_TOKEN');
  });
});
