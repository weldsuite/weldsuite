import { afterEach, describe, expect, it, vi } from 'vitest';
import { setRuntimeConfig } from '@/lib/runtime-config';
import {
  DEFAULT_BOOKING_PORTAL_URL,
  LOCAL_BOOKING_PORTAL_URL,
  TEST_BOOKING_PORTAL_URL,
  buildBookingPageUrl,
  getBookingPortalUrl,
  resolveBookingPortalUrl,
} from './booking-portal-url';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveBookingPortalUrl', () => {
  it('prefers the configured URL and strips trailing slashes', () => {
    expect(resolveBookingPortalUrl('https://book.example.com//', 'app.weldsuite.org')).toBe(
      'https://book.example.com',
    );
  });

  it('ignores a blank configured value', () => {
    expect(resolveBookingPortalUrl('  ', 'app.weldsuite.org')).toBe(DEFAULT_BOOKING_PORTAL_URL);
  });

  it('maps the production platform host to the production portal', () => {
    expect(resolveBookingPortalUrl('', 'app.weldsuite.org')).toBe('https://book.weldsuite.org');
  });

  it('maps the test platform host to the test portal', () => {
    expect(resolveBookingPortalUrl(undefined, 'app-test.weldsuite.org')).toBe(TEST_BOOKING_PORTAL_URL);
  });

  it('maps localhost to the portal dev port', () => {
    expect(resolveBookingPortalUrl(undefined, 'localhost')).toBe(LOCAL_BOOKING_PORTAL_URL);
    expect(resolveBookingPortalUrl(undefined, '127.0.0.1')).toBe(LOCAL_BOOKING_PORTAL_URL);
  });

  it('never falls back to the SPA origin for unknown hosts', () => {
    expect(resolveBookingPortalUrl('', 'weldsuite-abc.pages.dev')).toBe(DEFAULT_BOOKING_PORTAL_URL);
    expect(resolveBookingPortalUrl('', undefined)).toBe(DEFAULT_BOOKING_PORTAL_URL);
  });
});

describe('getBookingPortalUrl / buildBookingPageUrl', () => {
  it('uses VITE_BOOKING_PORTAL_URL when set', () => {
    vi.stubEnv('VITE_BOOKING_PORTAL_URL', 'http://localhost:3019/');
    expect(getBookingPortalUrl()).toBe('http://localhost:3019');
    expect(buildBookingPageUrl('acme', 'intro-call')).toBe('http://localhost:3019/acme/intro-call');
  });

  it('derives the portal from the current host when the env var is empty', () => {
    vi.stubEnv('VITE_BOOKING_PORTAL_URL', '');
    // jsdom serves tests from localhost.
    expect(getBookingPortalUrl()).toBe(LOCAL_BOOKING_PORTAL_URL);
  });

  describe('on a Kubernetes edition', () => {
    afterEach(() => setRuntimeConfig(null));

    it("has no link without a portal of its own, never Global's", () => {
      vi.stubEnv('VITE_BOOKING_PORTAL_URL', '');
      setRuntimeConfig({ backend: 'rust', edition: 'eu' });
      expect(getBookingPortalUrl()).toBeNull();
      expect(buildBookingPageUrl('acme', 'intro-call')).toBeNull();
    });

    it('uses the portal its /config.json names', () => {
      vi.stubEnv('VITE_BOOKING_PORTAL_URL', '');
      setRuntimeConfig({ backend: 'rust', env: { VITE_BOOKING_PORTAL_URL: 'https://book.example.eu' } });
      expect(buildBookingPageUrl('acme', 'intro-call')).toBe('https://book.example.eu/acme/intro-call');
    });
  });
});
