// `services/app-api.ts` wires the shared app-api client + domain clients and
// exposes the session token-getter setter. The client factory
// (`@weldsuite/mobile-platform/api`) and the domain factories are stubbed via the
// jest config moduleNameMapper, so these tests focus on the wiring. Which host
// a request goes to is decided (and tested) in mobile-platform, from the booted
// server runtime.
//
// Each test resets the module registry and re-requires the module.

describe('services/app-api', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  describe('appApi domain clients', () => {
    it('exposes a client for every mail/platform domain', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.resetModules() requires a fresh synchronous require per case
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
          'mailSubscriptions',
          'mailScheduled',
          'mailDomains',
          'pushTokens',
          'workspaces',
          'me',
          'mailboxes',
        ].sort(),
      );
    });

    it('default export is the same object as the named appApi export', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.resetModules() requires a fresh synchronous require per case
      const mod = require('../app-api');
      expect(mod.default).toBe(mod.appApi);
    });

    it('exports the raw client for surfaces without a domain wrapper', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.resetModules() requires a fresh synchronous require per case
      const { appApiClient } = require('../app-api');
      expect(appApiClient).toBeDefined();
    });
  });

  describe('getAppApiRequestInit', () => {
    it('builds an absolute /api URL with the bearer token and app header', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.resetModules() requires a fresh synchronous require per case
      const { getAppApiRequestInit, setAppApiTokenGetter } = require('../app-api');
      setAppApiTokenGetter(async () => 'jwt-token-123');
      await expect(getAppApiRequestInit('/mail-attachments/att_1/download')).resolves.toEqual({
        url: 'https://app-api.weldsuite.org/api/mail-attachments/att_1/download',
        headers: { Authorization: 'Bearer jwt-token-123', 'X-Weld-App': 'weldmail' },
      });
    });

    it('rejects without a session token', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.resetModules() requires a fresh synchronous require per case
      const { getAppApiRequestInit } = require('../app-api');
      await expect(getAppApiRequestInit('/x')).rejects.toThrow('Authentication required');
    });
  });

  describe('setAppApiTokenGetter', () => {
    it('passes a token getter to createClientApi that reflects the latest setter', async () => {
      // Capture the getToken callback handed to the client factory at load time.
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.resetModules() requires a fresh synchronous require per case
      const { createClientApi } = require('@weldsuite/api-client/client');
      let capturedGetToken: () => Promise<string | null> = async () => 'never-set';
      createClientApi.mockImplementation((opts: { getToken: () => Promise<string | null> }) => {
        capturedGetToken = opts.getToken;
        return { __stub: 'client' };
      });

      // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.resetModules() requires a fresh synchronous require per case
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
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.resetModules() requires a fresh synchronous require per case
      const { setAppApiTokenGetter } = require('../app-api');
      expect(typeof setAppApiTokenGetter).toBe('function');
    });
  });
});
