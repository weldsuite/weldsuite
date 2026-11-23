import { describe, expect, it } from 'vitest';
import { resolveObjectPanel } from '@/components/object-panel/object-panel-registry';
import './index';

describe('category object panel', () => {
  it('is registered, so a category opens in the object panel', () => {
    const definition = resolveObjectPanel('category');
    expect(definition?.label).toBe('Category');
    expect(definition?.component).toBeDefined();
  });
});
