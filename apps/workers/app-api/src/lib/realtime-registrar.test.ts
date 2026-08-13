import { describe, it, expect } from 'vitest';
import { getRealtimeRegistrar } from './realtime-registrar';
import type { Env } from '../types';

function env(partial: Partial<Env>): Env {
  return partial as Env;
}

describe('getRealtimeRegistrar', () => {
  it('returns null when registrar secrets are missing', () => {
    expect(getRealtimeRegistrar(env({}))).toBeNull();
    expect(getRealtimeRegistrar(env({ REALTIME_REGISTER_API_KEY: 'k' }))).toBeNull();
    expect(getRealtimeRegistrar(env({ REALTIME_REGISTER_CUSTOMER: 'c' }))).toBeNull();
  });

  it('passes the ADAC key through when present', () => {
    const rtr = getRealtimeRegistrar(
      env({
        REALTIME_REGISTER_API_KEY: 'key',
        REALTIME_REGISTER_CUSTOMER: 'cust',
        REALTIME_REGISTER_ADAC_API_KEY: ' adac_key \n',
      }),
    );
    expect(rtr).not.toBeNull();
    expect(rtr!.hasAdac).toBe(true);
  });

  it('reports hasAdac false when the ADAC key is unset', () => {
    const rtr = getRealtimeRegistrar(
      env({
        REALTIME_REGISTER_API_KEY: 'key',
        REALTIME_REGISTER_CUSTOMER: 'cust',
      }),
    );
    expect(rtr!.hasAdac).toBe(false);
  });
});
