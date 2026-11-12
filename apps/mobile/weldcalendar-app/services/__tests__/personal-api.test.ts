// `services/personal-api.ts` builds its PersonalApiClient lazily, from
// `personalApiOrigin()` (the booted server runtime), never at import time.
// (The Global app-api <-> personal-api pairing is tested in mobile-platform.)

describe('services/personal-api', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  function load(origin: { current: string }) {
    const ctor = jest.fn(function PersonalApiClient(this: { me: () => string }, baseUrl: string) {
      this.me = () => baseUrl;
    });
    jest.doMock('@weldsuite/personal-api-client', () => ({ PersonalApiClient: ctor }));
    jest.doMock('@weldsuite/mobile-platform/api', () => ({ personalApiOrigin: () => origin.current }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.resetModules() requires a fresh synchronous require per case
    const mod = require('../personal-api');
    return { ctor, personalApi: mod.personalApi as { me: () => string } };
  }

  it('does not read the runtime when the module is imported', () => {
    const { ctor } = load({ current: 'https://personal-api.example' });
    expect(ctor).not.toHaveBeenCalled();
  });

  it('builds the client on first use, against the runtime origin', () => {
    const { ctor, personalApi } = load({ current: 'https://personal-api.example' });
    expect(personalApi.me()).toBe('https://personal-api.example');
    personalApi.me();
    expect(ctor).toHaveBeenCalledTimes(1);
  });

  it('follows the origin when it changes', () => {
    const origin = { current: 'https://one.example' };
    const { ctor, personalApi } = load(origin);
    expect(personalApi.me()).toBe('https://one.example');
    origin.current = 'https://two.example';
    expect(personalApi.me()).toBe('https://two.example');
    expect(ctor).toHaveBeenCalledTimes(2);
  });
});
