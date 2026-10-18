import { describe, expect, it } from 'vitest';
import { parseSessionDevice } from './session-device';

describe('parseSessionDevice', () => {
  it('detects the desktop app reported as "Windows, Safari 2"', () => {
    expect(
      parseSessionDevice({ browserName: 'Safari', browserVersion: '2.0', deviceType: 'Windows', isMobile: false }),
    ).toEqual({ kind: 'desktop-app', os: 'Windows' });
  });

  it('detects Electron and WebView2 shells', () => {
    expect(parseSessionDevice({ browserName: 'Electron', browserVersion: '30', deviceType: 'Mac' })).toEqual({
      kind: 'desktop-app',
      os: 'macOS',
    });
    expect(parseSessionDevice({ browserName: 'WebView2', deviceType: 'Windows' })).toEqual({
      kind: 'desktop-app',
      os: 'Windows',
    });
  });

  it('treats a very old Safari on macOS as the desktop app, but not a real one', () => {
    expect(parseSessionDevice({ browserName: 'Safari', browserVersion: '2', deviceType: 'Mac' }).kind).toBe(
      'desktop-app',
    );
    expect(
      parseSessionDevice({ browserName: 'Safari', browserVersion: '17.4', deviceType: 'Mac', isMobile: false }),
    ).toMatchObject({ kind: 'browser', browser: 'Safari', version: '17' });
  });

  it('keeps Safari on iPhone as a browser', () => {
    expect(
      parseSessionDevice({ browserName: 'Safari', browserVersion: '1', deviceType: 'Mobile', isMobile: true }).kind,
    ).toBe('browser');
  });

  it('detects the Weld mobile apps reported as "Mobile, WeldMail 12/33"', () => {
    expect(
      parseSessionDevice({ browserName: 'WeldMail', browserVersion: '12/33', deviceType: 'Mobile', isMobile: true }),
    ).toEqual({ kind: 'weld-app', appName: 'WeldMail' });
    expect(parseSessionDevice({ browserName: 'WELDCHAT', isMobile: true })).toEqual({
      kind: 'weld-app',
      appName: 'WeldChat',
    });
  });

  it('detects OkHttp as the Android app', () => {
    expect(
      parseSessionDevice({ browserName: 'OkHttp', browserVersion: '5.0', deviceType: 'Mobile', isMobile: true }),
    ).toEqual({ kind: 'android-app' });
    expect(parseSessionDevice({ browserName: 'okhttp' })).toEqual({ kind: 'android-app' });
  });

  it('detects iOS native clients', () => {
    expect(parseSessionDevice({ browserName: 'CFNetwork', isMobile: true })).toEqual({ kind: 'ios-app' });
  });

  it('passes ordinary browsers through with the major version', () => {
    expect(
      parseSessionDevice({ browserName: 'Chrome', browserVersion: '126.0.6478.62', deviceType: 'Windows' }),
    ).toEqual({ kind: 'browser', browser: 'Chrome', version: '126', device: 'Windows', isMobile: false });
  });

  it('returns unknown when there is no activity', () => {
    expect(parseSessionDevice(null)).toEqual({ kind: 'unknown' });
    expect(parseSessionDevice({})).toEqual({ kind: 'unknown' });
  });
});
