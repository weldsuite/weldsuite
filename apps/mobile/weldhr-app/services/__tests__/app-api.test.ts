describe('services/app-api', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('exposes the WeldHR and payroll domains alongside the platform ones', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { appApi, default: fallback } = require('../app-api');
    expect(Object.keys(appApi).sort()).toEqual(['account', 'dashboard', 'me', 'payroll', 'pushTokens', 'weldhr', 'workspaces']);
    expect(fallback).toBe(appApi);
  });

  it('identifies itself as WeldHR so per-app permissions apply', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createMobileApiClient } = require('@weldsuite/mobile-platform/api');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../app-api');
    const options = (createMobileApiClient as jest.Mock).mock.calls.at(-1)[0];
    expect(options.appCode).toBe('weldhr');
  });

  it('reads the session token through the wired getter', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createMobileApiClient } = require('@weldsuite/mobile-platform/api');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { setAppApiTokenGetter } = require('../app-api');
    const options = (createMobileApiClient as jest.Mock).mock.calls.at(-1)[0];
    await expect(options.getToken()).resolves.toBeNull();
    setAppApiTokenGetter(() => Promise.resolve('tok'));
    await expect(options.getToken()).resolves.toBe('tok');
  });
});
