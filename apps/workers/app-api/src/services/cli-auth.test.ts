/**
 * Unit tests for CLI device-code helpers (no Worker runtime required).
 */
import { describe, expect, it } from 'vitest';
import {
  formatUserCode,
  normalizeUserCode,
  resolveLoginUrl,
  defaultExternalApiUrl,
  defaultLoginUrl,
  generateUserCode,
  generateDeviceCode,
} from './cli-auth';

describe('cli-auth helpers', () => {
  it('normalizes and formats user codes', () => {
    expect(normalizeUserCode('ab cd-ef12')).toBe('ABCDEF12');
    expect(formatUserCode('ABCDEF12')).toBe('ABCD-EF12');
    expect(formatUserCode('ABCD')).toBe('ABCD');
  });

  it('generates opaque device + readable user codes', () => {
    const device = generateDeviceCode();
    expect(device).toMatch(/^[a-f0-9]{64}$/);
    const user = generateUserCode();
    expect(user).toHaveLength(8);
    expect(user).toMatch(/^[A-Z2-9]+$/);
  });

  it('resolves login URLs against an allowlist', () => {
    expect(resolveLoginUrl(undefined, 'production')).toBe('https://developer.weldsuite.org');
    expect(resolveLoginUrl(undefined, 'test')).toBe('https://developer-test.weldsuite.org');
    expect(resolveLoginUrl('https://developer.weldsuite.org', 'production')).toBe(
      'https://developer.weldsuite.org',
    );
    expect(resolveLoginUrl('http://localhost:3202', 'test')).toBe('http://localhost:3202');
    expect(resolveLoginUrl('https://evil.example', 'production')).toBe(
      'https://developer.weldsuite.org',
    );
  });

  it('picks external-api hosts from ENVIRONMENT', () => {
    expect(defaultExternalApiUrl('production')).toBe('https://api.weldsuite.org');
    expect(defaultExternalApiUrl('test')).toBe('https://api-test.weldsuite.org');
    expect(defaultLoginUrl('preview')).toBe('https://developer-test.weldsuite.org');
  });
});
