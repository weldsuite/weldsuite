import { describe, it, expect } from 'vitest';
import { getRealtimeRegistrar } from './realtime-registrar';
import type { Env } from '../types';

function env(partial: Partial<Env>): Env {
  return partial as Env;
}

describe('getRealtimeRegistrar', () => {
  it('returns null when either secret is missing or whitespace', () => {
    expect(getRealtimeRegistrar(env({}))).toBeNull();
    expect(getRealtimeRegistrar(env({ REALTIME_REGISTER_API_KEY: 'k' }))).toBeNull();
    expect(getRealtimeRegistrar(env({ REALTIME_REGISTER_CUSTOMER: 'c' }))).toBeNull();
    expect(
      getRealtimeRegistrar(
        env({ REALTIME_REGISTER_API_KEY: '  \n', REALTIME_REGISTER_CUSTOMER: 'c' }),
      ),
    ).toBeNull();
  });

  it('returns a client when both secrets are present, even with padding', () => {
    expect(
      getRealtimeRegistrar(
        env({
          REALTIME_REGISTER_API_KEY: ' key \n',
          REALTIME_REGISTER_CUSTOMER: ' cust ',
        }),
      ),
    ).not.toBeNull();
  });
});
