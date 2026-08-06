import { describe, expect, it } from 'vitest';
import type { Env } from '../types';
import { billingWorkerUrl } from './telnyx';

function envWith(environment: string): Env {
  return { ENVIRONMENT: environment } as Env;
}

describe('billingWorkerUrl', () => {
  it('points production at the billing-worker custom domain', () => {
    expect(billingWorkerUrl(envWith('production'))).toBe(
      'https://billing-worker.weldsuite.org',
    );
  });

  it('points preview at the same live billing-worker host', () => {
    expect(billingWorkerUrl(envWith('preview'))).toBe(
      'https://billing-worker.weldsuite.org',
    );
  });

  it('uses localhost for development', () => {
    expect(billingWorkerUrl(envWith('development'))).toBe('http://localhost:8788');
  });
});
