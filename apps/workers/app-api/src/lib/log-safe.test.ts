import { describe, expect, it } from 'vitest';
import { logSafe } from './log-safe';

describe('logSafe', () => {
  it('replaces line breaks so a value cannot forge log entries', () => {
    expect(logSafe('abc\r\n[INFO] forged')).toBe('abc [INFO] forged');
    expect(logSafe('a\u2028b\u2029c')).toBe('a b c');
  });

  it('stringifies non-string values', () => {
    expect(logSafe(42)).toBe('42');
    expect(logSafe(undefined)).toBe('undefined');
  });
});
