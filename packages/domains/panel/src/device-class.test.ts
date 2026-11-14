import { describe, expect, it } from 'vitest';
import { deviceClassFromViewport, isDeviceClass } from './device-class';

describe('deviceClassFromViewport', () => {
  it('splits at 768 and 1024 pixels', () => {
    expect(deviceClassFromViewport(0)).toBe('mobile');
    expect(deviceClassFromViewport(767)).toBe('mobile');
    expect(deviceClassFromViewport(768)).toBe('tablet');
    expect(deviceClassFromViewport(1023)).toBe('tablet');
    expect(deviceClassFromViewport(1024)).toBe('desktop');
    expect(deviceClassFromViewport(2560)).toBe('desktop');
  });

  it('treats an unknown width as desktop', () => {
    expect(deviceClassFromViewport(null)).toBe('desktop');
    expect(deviceClassFromViewport(undefined)).toBe('desktop');
    expect(deviceClassFromViewport(Number.NaN)).toBe('desktop');
  });
});

describe('isDeviceClass', () => {
  it('knows the three classes', () => {
    expect(['desktop', 'tablet', 'mobile'].every(isDeviceClass)).toBe(true);
    expect(isDeviceClass('phone')).toBe(false);
    expect(isDeviceClass(null)).toBe(false);
  });
});
