import { describe, expect, it } from 'vitest';
import { resolveObjectPanel } from '@/components/object-panel/object-panel-registry';
import './index';

describe('discount object panel', () => {
  it('is registered, so a discount opens in the object panel', () => {
    const definition = resolveObjectPanel('discount');
    expect(definition?.label).toBe('Discount');
    expect(definition?.component).toBeDefined();
  });
});
