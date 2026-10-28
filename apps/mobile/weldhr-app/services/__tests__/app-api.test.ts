describe('services/app-api', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('defaults to the local app-api when the env var is unset', () => {
    delete process.env.EXPO_PUBLIC_APP_API_URL;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { APP_API_URL } = require('../app-api');
    expect(APP_API_URL).toBe('http://localhost:8789');
  });

  it('exposes the WeldHR and payroll domains alongside the platform ones', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { appApi, default: fallback } = require('../app-api');
    expect(Object.keys(appApi).sort()).toEqual(['account', 'dashboard', 'me', 'payroll', 'pushTokens', 'weldhr', 'workspaces']);
    expect(fallback).toBe(appApi);
  });

  it('identifies itself as WeldHR so per-app permissions apply', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createClientApi } = require('@weldsuite/api-client/client');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../app-api');
    const options = (createClientApi as jest.Mock).mock.calls.at(-1)[0];
    expect(options.getExtraHeaders()).toEqual({ 'X-Weld-App': 'weldhr' });
  });

  it('builds authenticated document URLs and refuses without a session', async () => {
    process.env.EXPO_PUBLIC_APP_API_URL = 'https://app-api-test.weldsuite.org';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getAppApiRequestInit, setAppApiTokenGetter } = require('../app-api');
    await expect(getAppApiRequestInit('/weldhr/me/payslips/ps_1/pdf')).rejects.toThrow('Authentication required');

    setAppApiTokenGetter(() => Promise.resolve('tok'));
    await expect(getAppApiRequestInit('/weldhr/me/payslips/ps_1/pdf')).resolves.toEqual({
      url: 'https://app-api-test.weldsuite.org/api/weldhr/me/payslips/ps_1/pdf',
      headers: { Authorization: 'Bearer tok', 'X-Weld-App': 'weldhr' },
    });
  });
});
