import { describe, expect, it } from 'vitest';
import {
  isOfficialPublisherWorkspace,
  isSafeAppLifecycleWebhookUrl,
  toUserAppStoreListing,
} from './user-apps';

describe('isOfficialPublisherWorkspace', () => {
  it('matches trimmed comma-separated workspace ids', () => {
    expect(
      isOfficialPublisherWorkspace({ WELDSUITE_APP_PUBLISHER_WORKSPACE_IDS: 'ws_a, ws_b' }, 'ws_b'),
    ).toBe(true);
    expect(
      isOfficialPublisherWorkspace({ WELDSUITE_APP_PUBLISHER_WORKSPACE_IDS: 'ws_a' }, 'ws_other'),
    ).toBe(false);
    expect(isOfficialPublisherWorkspace({}, 'ws_a')).toBe(false);
  });
});

describe('isSafeAppLifecycleWebhookUrl', () => {
  it('allows https and loopback http', () => {
    expect(isSafeAppLifecycleWebhookUrl('https://example.com/hooks/apps')).toBe(true);
    expect(isSafeAppLifecycleWebhookUrl('http://localhost:8787/hook')).toBe(true);
  });

  it('rejects credentials and arbitrary http', () => {
    expect(isSafeAppLifecycleWebhookUrl('http://evil.example.com')).toBe(false);
    expect(isSafeAppLifecycleWebhookUrl('https://user:pass@example.com/x')).toBe(false);
  });
});

describe('toUserAppStoreListing', () => {
  it('strips webhook and Stripe ids from public store payloads', () => {
    const listing = toUserAppStoreListing({
      code: 'demo',
      publisherType: 'weldsuite',
      webhookUrl: 'https://secret.example/hook',
      stripeProductId: 'prod_x',
      stripePriceId: 'price_x',
      websiteUrl: 'https://weldsuite.org',
    });
    expect(listing).toEqual({
      code: 'demo',
      publisherType: 'weldsuite',
      websiteUrl: 'https://weldsuite.org',
    });
  });
});
