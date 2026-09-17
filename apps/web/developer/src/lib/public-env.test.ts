import { describe, expect, it } from 'vitest';
import { getAppApiUrl, getPlatformUrl } from './public-env';

describe('public-env', () => {
  it('exports URL helpers', () => {
    expect(typeof getAppApiUrl()).toBe('string');
    expect(typeof getPlatformUrl()).toBe('string');
  });
});
