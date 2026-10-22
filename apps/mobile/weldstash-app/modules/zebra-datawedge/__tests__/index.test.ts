import * as fs from 'fs';
import * as path from 'path';

jest.mock('expo', () => ({
  requireOptionalNativeModule: jest.fn(() => null),
}));

type ScanListener = (event: { data: string }) => void;

function makeNative(isSupported: () => boolean) {
  const listeners: ScanListener[] = [];
  const native = {
    isSupported: jest.fn(isSupported),
    configureProfile: jest.fn(),
    addListener: jest.fn((_event: string, listener: ScanListener) => {
      listeners.push(listener);
      return { remove: jest.fn() };
    }),
  };
  return { native, listeners };
}

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

  it('forwards scans from the native module when DataWedge is installed', () => {
    const { native, listeners } = makeNative(() => true);
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

  it('is not available on a phone: the module is compiled in but DataWedge is not installed', () => {
    const { native } = makeNative(() => false);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('expo').requireOptionalNativeModule.mockReturnValue(native);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../index');
    expect(mod.isZebraScannerAvailable()).toBe(false);

    const sub = mod.addZebraScanListener(() => {});
    mod.configureZebraProfile();
    expect(() => sub.remove()).not.toThrow();
    expect(native.addListener).not.toHaveBeenCalled();
    expect(native.configureProfile).not.toHaveBeenCalled();
  });

  it('treats a failing support check as not available', () => {
    const { native } = makeNative(() => {
      throw new Error('native call failed');
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('expo').requireOptionalNativeModule.mockReturnValue(native);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../index');
    expect(mod.isZebraScannerAvailable()).toBe(false);
    expect(native.addListener).not.toHaveBeenCalled();
  });

  it('asks the native module once and remembers the answer', () => {
    const { native } = makeNative(() => true);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('expo').requireOptionalNativeModule.mockReturnValue(native);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../index');
    mod.isZebraScannerAvailable();
    mod.isZebraScannerAvailable();
    expect(native.isSupported).toHaveBeenCalledTimes(1);
  });
});

describe('ZebraDataWedge native detection', () => {
  const moduleDir = path.join(__dirname, '..');
  const source = fs.readFileSync(
    path.join(moduleDir, 'android/src/main/java/expo/modules/zebradatawedge/ZebraDataWedgeModule.kt'),
    'utf8',
  );
  const manifest = fs.readFileSync(
    path.join(moduleDir, 'android/src/main/AndroidManifest.xml'),
    'utf8',
  );

  it('reports support only when the DataWedge package is installed and enabled', () => {
    expect(source).toMatch(/Function\("isSupported"\)\s*\{\s*isDataWedgeAvailable\(\)/);
    expect(source).toContain('getApplicationInfo(DATAWEDGE_PACKAGE, 0).enabled');
    expect(source).toContain('PackageManager.NameNotFoundException');
  });

  it('can see the DataWedge package on Android 11+ (package visibility)', () => {
    expect(manifest).toContain('<package android:name="com.symbol.datawedge" />');
  });

  it('does not start the scan receiver or configure a profile without DataWedge', () => {
    expect(source).toMatch(
      /OnStartObserving\s*\{\s*if \(isDataWedgeAvailable\(\)\) \{\s*registerScanReceiver\(\)/,
    );
    expect(source).toContain('if (isDataWedgeAvailable()) configureProfile()');
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
