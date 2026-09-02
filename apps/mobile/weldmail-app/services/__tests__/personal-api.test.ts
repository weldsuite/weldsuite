describe('resolvePersonalApiUrl', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('pairs production app-api with production personal-api', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.resetModules()
    const { resolvePersonalApiUrl } = require('../personal-api');
    expect(
      resolvePersonalApiUrl('https://ignored.example', 'https://app-api.weldsuite.org'),
    ).toBe('https://personal-api.weldsuite.org');
  });

  it('pairs test app-api with test personal-api', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.resetModules()
    const { resolvePersonalApiUrl } = require('../personal-api');
    expect(
      resolvePersonalApiUrl(undefined, 'https://app-api-test.weldsuite.org'),
    ).toBe('https://personal-api-test.weldsuite.org');
  });

  it('defaults to local wrangler when app-api is unset', () => {
    delete process.env.EXPO_PUBLIC_APP_API_URL;
    delete process.env.EXPO_PUBLIC_PERSONAL_API_URL;
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.resetModules()
    const { resolvePersonalApiUrl } = require('../personal-api');
    expect(resolvePersonalApiUrl()).toBe('http://localhost:8787');
  });
});
