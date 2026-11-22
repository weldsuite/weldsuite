import { describe, expect, it } from 'vitest';
import { resolveObjectPanel } from '@/components/object-panel/object-panel-registry';
import './index';

describe('order object panel', () => {
  it('is registered, so an order opens in the object panel', () => {
    const definition = resolveObjectPanel('order');
    expect(definition?.label).toBe('Order');
    expect(definition?.component).toBeDefined();
  });
});
