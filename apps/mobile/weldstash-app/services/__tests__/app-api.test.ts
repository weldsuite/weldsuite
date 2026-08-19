describe('services/app-api', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('APP_API_URL', () => {
    it('defaults to the local app-api when the env var is unset', () => {
      delete process.env.EXPO_PUBLIC_APP_API_URL;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { APP_API_URL } = require('../app-api');
      expect(APP_API_URL).toBe('http://localhost:8789');
    });

    it('uses EXPO_PUBLIC_APP_API_URL when provided', () => {
      process.env.EXPO_PUBLIC_APP_API_URL = 'https://app-api.weldsuite.org';
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { APP_API_URL } = require('../app-api');
      expect(APP_API_URL).toBe('https://app-api.weldsuite.org');
    });
  });

  describe('appApi domain clients', () => {
    it('exposes products, inventory, warehouses, and pick lists alongside platform domains', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { appApi } = require('../app-api');
      expect(Object.keys(appApi).sort()).toEqual(
        [
          'dashboard',
          'inventory',
          'me',
          'pickLists',
          'products',
          'pushTokens',
          'warehouses',
          'workspaces',
        ].sort(),
      );
    });

    it('default export is the same object as the named appApi export', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('../app-api');
      expect(mod.default).toBe(mod.appApi);
    });
  });

  describe('setAppApiTokenGetter', () => {
    it('passes a token getter to createClientApi that reflects the latest setter', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createClientApi } = require('@weldsuite/api-client/client');
      let capturedGetToken: () => Promise<string | null> = async () => 'never-set';
      createClientApi.mockImplementation((opts: { getToken: () => Promise<string | null> }) => {
        capturedGetToken = opts.getToken;
        return { __stub: 'client' };
      });

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { setAppApiTokenGetter } = require('../app-api');
      setAppApiTokenGetter(async () => 'tok_abc');
      await expect(capturedGetToken()).resolves.toBe('tok_abc');

      setAppApiTokenGetter(null);
      await expect(capturedGetToken()).resolves.toBeNull();
    });
  });
});
