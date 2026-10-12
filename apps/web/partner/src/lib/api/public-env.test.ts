import { describe, expect, it } from 'vitest';
import { isTestHost } from './public-env';

describe('isTestHost', () => {
  it('treats the test domain and Vercel previews as test', () => {
    expect(isTestHost('partner-test.weldsuite.org')).toBe(true);
    expect(isTestHost('weldsuite-partner-git-feature.vercel.app')).toBe(true);
  });

  it('treats the production domain as production', () => {
    expect(isTestHost('partner.weldsuite.org')).toBe(false);
    expect(isTestHost('partner-test.weldsuite.org.evil.com')).toBe(false);
  });
});
