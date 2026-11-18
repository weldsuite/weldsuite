// `services/personal-api.ts` builds its PersonalApiClient lazily from the booted
// server runtime's personal-api origin (`lazyClient` and the Global pairing are
// tested in @weldsuite/mobile-platform).

describe('services/personal-api', () => {
  it('wires PersonalApiClient to the runtime origin through lazyClient', () => {
    jest.resetModules();
    const ctor = jest.fn(function PersonalApiClient(this: { baseUrl: string }, baseUrl: string) {
      this.baseUrl = baseUrl;
    });
    const personalApiOrigin = jest.fn(() => 'https://personal-api.example');
    const lazyClient = jest.fn((origin: () => string, build: (origin: string) => unknown) => ({ origin, build }));
    jest.doMock('@weldsuite/personal-api-client', () => ({ PersonalApiClient: ctor }));
    jest.doMock('@weldsuite/mobile-platform/api', () => ({ personalApiOrigin, lazyClient }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.resetModules() needs a fresh synchronous require
    const { personalApi } = require('../personal-api') as {
      personalApi: { origin: () => string; build: (origin: string) => { baseUrl: string } };
    };

    expect(personalApiOrigin).not.toHaveBeenCalled();
    expect(personalApi.origin).toBe(personalApiOrigin);
    expect(personalApi.build('https://personal-api.example').baseUrl).toBe('https://personal-api.example');
    expect(ctor).toHaveBeenCalledTimes(1);
  });
});
