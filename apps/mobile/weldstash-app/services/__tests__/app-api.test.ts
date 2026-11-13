describe('services/app-api', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('createMobileApiClient', () => {
    it('builds the client for this app, with no host baked in at import time', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createMobileApiClient } = require('@weldsuite/mobile-platform/api');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../app-api');
      expect(createMobileApiClient).toHaveBeenCalledTimes(1);
      expect(createMobileApiClient).toHaveBeenCalledWith(
        expect.objectContaining({ appCode: 'weldstash', getToken: expect.any(Function) }),
      );
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
          'sendcloud',
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
    it('passes a token getter to createMobileApiClient that reflects the latest setter', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createMobileApiClient } = require('@weldsuite/mobile-platform/api');
      let capturedGetToken: () => Promise<string | null> = async () => 'never-set';
      createMobileApiClient.mockImplementation((opts: { getToken: () => Promise<string | null> }) => {
        capturedGetToken = opts.getToken;
        return { client: { __stub: 'client' }, requestInit: jest.fn() };
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
