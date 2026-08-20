import * as fs from 'fs';
import * as path from 'path';

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

describe('ZebraDataWedge native scan receiver', () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      '../android/src/main/java/expo/modules/zebradatawedge/ZebraDataWedgeModule.kt',
    ),
    'utf8',
  );

  it('does not listen for the well-known DataWedge scan action', () => {
    expect(source).not.toContain('com.symbol.datawedge.ACTION_BARCODE_SCANNED');
    expect(source).not.toContain('SCAN_ACTION_ALT');
    expect(source).toContain('addAction(SCAN_ACTION)');
  });

  it('registers the exported receiver with a sender-permission argument', () => {
    expect(source).toContain('Context.RECEIVER_EXPORTED');
    expect(source).toContain('senderPermission');
    expect(source).toContain('com.symbol.datawedge.permission.contentprovider');
  });

  it('drops broadcasts that are not from DataWedge when the sender is known', () => {
    expect(source).toContain('sentFromPackage');
    expect(source).toContain('sentFromUid');
    expect(source).toContain('isTrustedPackage');
    expect(source).toContain('com.symbol.datawedge');
    expect(source).toContain('com.weldsuite.weldstash.SCAN');
  });

  it('configures DataWedge to send an explicit broadcast to this package', () => {
    expect(source).toContain('intent_component_info');
    expect(source).toContain('setPackage(DATAWEDGE_PACKAGE)');
  });

  it('passes PLUGIN_CONFIG as an ArrayList so DataWedge applies intent output', () => {
    // DataWedge reads PLUGIN_CONFIG via getParcelableArrayList. A Bundle[]
    // from putParcelableArray is ignored, which leaves keystroke output on
    // and intent output off — scans then require a focused TextInput.
    expect(source).toContain('putParcelableArrayList("PLUGIN_CONFIG"');
    expect(source).not.toMatch(/putParcelableArray\(\s*"PLUGIN_CONFIG"/);
    expect(source).toContain('putInt("intent_delivery", 2)');
  });
});
