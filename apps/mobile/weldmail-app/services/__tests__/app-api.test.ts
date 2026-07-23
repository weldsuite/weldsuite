// `services/app-api.ts` wires the shared app-api client + domain clients and
// exposes the Clerk token-getter setter. The underlying client factory and the
// domain factories are stubbed via the jest config moduleNameMapper, so these
// tests focus on the wiring and the env-driven config the module computes at
// load time.
//
// Env + module-load behaviour is read at import time, so each test resets the
// module registry and re-requires the module under controlled conditions.

describe('services/app-api', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    // Fresh copy of env per test so mutations don't leak across cases.
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('APP_API_URL', () => {
    it('defaults to the local app-api when the env var is unset', () => {
      delete process.env.EXPO_PUBLIC_APP_API_URL;
      const { APP_API_URL } = require('../app-api');
      expect(APP_API_URL).toBe('http://localhost:8789');
    });

    it('uses EXPO_PUBLIC_APP_API_URL when provided', () => {
      process.env.EXPO_PUBLIC_APP_API_URL = 'https://app-api.weldsuite.org';
      const { APP_API_URL } = require('../app-api');
      expect(APP_API_URL).toBe('https://app-api.weldsuite.org');
    });
  });

  describe('appApi domain clients', () => {
    it('exposes a client for every mail/platform domain', () => {
      const { appApi } = require('../app-api');
      expect(Object.keys(appApi).sort()).toEqual(
        [
          'mailAccounts',
          'mailMessages',
          'mailThreads',
          'mailLabels',
          'mailDrafts',
          'mailWeldmail',
          'mailSnooze',
          'mailScheduled',
          'mailDomains',
          'pushTokens',
          'workspaces',
          'me',
        ].sort(),
      );
    });

    it('default export is the same object as the named appApi export', () => {
      const mod = require('../app-api');
      expect(mod.default).toBe(mod.appApi);
    });

    it('exports the raw client for surfaces without a domain wrapper', () => {
      const { appApiClient } = require('../app-api');
      expect(appApiClient).toBeDefined();
    });
  });

  describe('setAppApiTokenGetter', () => {
    it('passes a token getter to createClientApi that reflects the latest setter', async () => {
      // Capture the getToken callback handed to the client factory at load time.
      const { createClientApi } = require('@weldsuite/api-client/client');
      let capturedGetToken: () => Promise<string | null> = async () => 'never-set';
      createClientApi.mockImplementation((opts: { getToken: () => Promise<string | null> }) => {
        capturedGetToken = opts.getToken;
        return { __stub: 'client' };
      });

      const { setAppApiTokenGetter } = require('../app-api');

      // Before wiring, the default getter resolves to null.
      await expect(capturedGetToken()).resolves.toBeNull();

      // After wiring, the captured getter delegates to the new function.
      setAppApiTokenGetter(async () => 'jwt-token-123');
      await expect(capturedGetToken()).resolves.toBe('jwt-token-123');

      // Resetting with null restores the null-returning default.
      setAppApiTokenGetter(null);
      await expect(capturedGetToken()).resolves.toBeNull();
    });

    it('is exported as a function', () => {
      const { setAppApiTokenGetter } = require('../app-api');
      expect(typeof setAppApiTokenGetter).toBe('function');
    });
  });
});
