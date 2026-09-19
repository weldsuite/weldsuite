import { describe, expect, it } from 'vitest';
import { statusBadgeVariant } from './index';
import { cn } from './cn';

describe('ui helpers', () => {
  it('cn joins truthy class names', () => {
    expect(cn('a', false, undefined, 'b', null, '')).toBe('a b');
  });

  it('statusBadgeVariant mirrors platform commerce columns', () => {
    expect(statusBadgeVariant('active')).toBe('default');
    expect(statusBadgeVariant('draft')).toBe('outline');
    expect(statusBadgeVariant('archived')).toBe('secondary');
    expect(statusBadgeVariant(undefined)).toBe('secondary');
  });
});
