import { describe, expect, it } from 'vitest';
import { lookupCrmUrl } from './desk-phone-tools';

describe('lookupCrmUrl', () => {
  it('points Telnyx at call-api, not app-api', () => {
    expect(lookupCrmUrl({ ENVIRONMENT: 'production' })).toBe(
      'https://call-api.weldsuite.org/public/webhooks/telnyx/tools/lookup_crm',
    );
    expect(lookupCrmUrl({ ENVIRONMENT: 'test' })).toBe(
      'https://call-api-test.weldsuite.org/public/webhooks/telnyx/tools/lookup_crm',
    );
  });

  it('keeps an APP_API_PUBLIC_URL tunnel it cannot map', () => {
    const env = { ENVIRONMENT: 'development', APP_API_PUBLIC_URL: 'https://abc.trycloudflare.com' };
    expect(lookupCrmUrl(env)).toBe('https://abc.trycloudflare.com/public/webhooks/telnyx/tools/lookup_crm');
  });
});
