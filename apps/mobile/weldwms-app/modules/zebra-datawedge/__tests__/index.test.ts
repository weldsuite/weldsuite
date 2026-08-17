jest.mock('expo', () => ({
  requireOptionalNativeModule: jest.fn(() => null),
}));

describe('zebra-datawedge JS facade', () => {
  beforeEach(() => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { requireOptionalNativeModule } = require('expo');
    requireOptionalNativeModule.mockReset();
    requireOptionalNativeModule.mockReturnValue(null);
  });

  it('no-ops when the native module is missing (iOS / simulator / Expo Go)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../index');
    expect(mod.isZebraScannerAvailable()).toBe(false);
    expect(() => mod.configureZebraProfile()).not.toThrow();
    const sub = mod.addZebraScanListener(() => {});
    expect(() => sub.remove()).not.toThrow();
  });

  it('forwards scans from the native module', () => {
    const listeners: Array<(event: { data: string }) => void> = [];
    const native = {
      configureProfile: jest.fn(),
      addListener: jest.fn((_event: string, listener: (event: { data: string }) => void) => {
        listeners.push(listener);
        return { remove: jest.fn() };
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('expo').requireOptionalNativeModule.mockReturnValue(native);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../index');
    expect(mod.isZebraScannerAvailable()).toBe(true);

    const received: string[] = [];
    mod.addZebraScanListener((event: { data: string }) => received.push(event.data));
    mod.configureZebraProfile();

    expect(native.configureProfile).toHaveBeenCalledTimes(1);
    expect(native.addListener).toHaveBeenCalledWith('onBarcodeScanned', expect.any(Function));
    listeners[0]({ data: '0123456789012' });
    expect(received).toEqual(['0123456789012']);
  });
});
