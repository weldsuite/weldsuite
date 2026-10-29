import { afterEach, describe, expect, it } from 'vitest';
import { setRuntimeConfig } from '@/lib/runtime-config';
import { chatCallsAvailable } from './calls-available';

afterEach(() => setRuntimeConfig(null));

describe('chatCallsAvailable', () => {
  it('offers calls on Global (no runtime config)', () => {
    expect(chatCallsAvailable()).toBe(true);
  });

  it('offers no calls on the Kubernetes editions', () => {
    setRuntimeConfig({ backend: 'rust', modules: ['core', 'chat'] });
    expect(chatCallsAvailable()).toBe(false);
  });
});
