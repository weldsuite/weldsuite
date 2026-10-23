import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../index';
import { resolveRegistrarConfig } from './webhooks';

function env(partial: Partial<Env>): Env {
  return { ENVIRONMENT: 'test', ...partial } as Env;
}

const RTR = { REALTIME_REGISTER_API_KEY: 'rtr_key', REALTIME_REGISTER_CUSTOMER: 'weldsuite' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveRegistrarConfig', () => {
  it('needs the Cloudflare credentials outside the DNS sandbox', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(resolveRegistrarConfig(env(RTR))).toBeNull();
    expect(
      resolveRegistrarConfig(env({ ...RTR, CLOUDFLARE_API_TOKEN: 'cf', CLOUDFLARE_ACCOUNT_ID: 'acct' })),
    ).toEqual({ rtrKey: 'rtr_key', rtrCustomer: 'weldsuite', cfToken: 'cf', cfAccountId: 'acct' });
  });

  it('does not need them in DNS sandbox mode', () => {
    const config = resolveRegistrarConfig(env({ ...RTR, WELDHOST_DNS_MODE: 'sandbox' }));
    expect(config).toMatchObject({ rtrKey: 'rtr_key', rtrCustomer: 'weldsuite' });
    expect(config?.cfToken).toBeTruthy();
    expect(config?.cfAccountId).toBeTruthy();
  });

  it('still uses real Cloudflare credentials when they are set in sandbox mode', () => {
    const config = resolveRegistrarConfig(
      env({ ...RTR, WELDHOST_DNS_MODE: 'sandbox', CLOUDFLARE_API_TOKEN: 'cf', CLOUDFLARE_ACCOUNT_ID: 'acct' }),
    );
    expect(config).toMatchObject({ cfToken: 'cf', cfAccountId: 'acct' });
  });

  it('still needs the registrar credentials in sandbox mode', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(resolveRegistrarConfig(env({ WELDHOST_DNS_MODE: 'sandbox' }))).toBeNull();
  });
});
