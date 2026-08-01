import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getEnv, getAllEnv } from './env';

// `Window._ENV` is already declared globally by `./env` (imported above);
// redeclaring it here with a looser type conflicts with that declaration.

describe('getEnv', () => {
  beforeEach(() => {
    delete window._ENV;
  });

  afterEach(() => {
    delete window._ENV;
    vi.unstubAllEnvs();
  });

  it('returns the value from window._ENV when present (Docker runtime)', () => {
    window._ENV = { VITE_API_BASE_URL: 'https://runtime.example' };
    expect(getEnv('VITE_API_BASE_URL')).toBe('https://runtime.example');
  });

  it('falls back to import.meta.env when window._ENV is absent', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://meta.example');
    expect(getEnv('VITE_API_BASE_URL')).toBe('https://meta.example');
  });

  it('returns empty string when neither source has the variable', () => {
    expect(getEnv('VITE_BETTERSTACK_SOURCE_TOKEN')).toBe('');
  });

  it('window._ENV takes precedence over import.meta.env', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://meta.example');
    window._ENV = { VITE_API_BASE_URL: 'https://runtime.example' };
    expect(getEnv('VITE_API_BASE_URL')).toBe('https://runtime.example');
  });
});

describe('getAllEnv', () => {
  beforeEach(() => {
    delete window._ENV;
  });

  it('returns window._ENV verbatim when present', () => {
    const fake = { VITE_API_BASE_URL: 'https://x', VITE_MIXPANEL_TOKEN: 'tok' };
    window._ENV = fake;
    expect(getAllEnv()).toEqual(fake);
  });

  it('returns a snapshot from import.meta.env when window._ENV is missing', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://meta');
    const all = getAllEnv();
    expect(all.VITE_API_BASE_URL).toBe('https://meta');
    // Keys we didn't stub are still present (undefined or empty); the
    // shape contract is what we care about.
    expect(all).toHaveProperty('VITE_CLERK_PUBLISHABLE_KEY');
    expect(all).toHaveProperty('VITE_MIXPANEL_TOKEN');
  });
});
