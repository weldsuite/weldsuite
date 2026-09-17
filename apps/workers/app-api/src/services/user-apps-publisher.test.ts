import { describe, expect, it } from 'vitest';
import {
  appLifecycleWebhookUrlSchema,
  isSafeAppLifecycleWebhookUrl,
} from '@weldsuite/app-api-client/schemas/user-apps';
import {
  appFieldsFromManifest,
  isOfficialPublisherWorkspace,
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
  it('allows public https DNS hostnames', () => {
    expect(isSafeAppLifecycleWebhookUrl('https://example.com/hooks/apps')).toBe(true);
    expect(isSafeAppLifecycleWebhookUrl('https://hooks.example.org/weld')).toBe(true);
  });

  it('rejects http, credentials, loopback, private, metadata, and IP literals', () => {
    expect(isSafeAppLifecycleWebhookUrl('http://example.com/hook')).toBe(false);
    expect(isSafeAppLifecycleWebhookUrl('http://localhost:8787/hook')).toBe(false);
    expect(isSafeAppLifecycleWebhookUrl('https://user:pass@example.com/x')).toBe(false);
    expect(isSafeAppLifecycleWebhookUrl('https://127.0.0.1/hook')).toBe(false);
    expect(isSafeAppLifecycleWebhookUrl('https://10.0.0.5/hook')).toBe(false);
    expect(isSafeAppLifecycleWebhookUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isSafeAppLifecycleWebhookUrl('https://[::1]/hook')).toBe(false);
    expect(isSafeAppLifecycleWebhookUrl('https://metadata.google.internal/')).toBe(false);
    expect(isSafeAppLifecycleWebhookUrl('https://service.local/hook')).toBe(false);
    expect(isSafeAppLifecycleWebhookUrl('https://8.8.8.8/hook')).toBe(false);
  });

  it('aligns Zod write-time validation with the same policy', () => {
    expect(appLifecycleWebhookUrlSchema.safeParse('https://example.com/hooks').success).toBe(true);
    expect(appLifecycleWebhookUrlSchema.safeParse('https://169.254.169.254/').success).toBe(false);
    expect(appLifecycleWebhookUrlSchema.safeParse('http://example.com/hooks').success).toBe(false);
  });
});

describe('appFieldsFromManifest', () => {
  it('preserves listing and webhook fields when the manifest omits them', () => {
    const fields = appFieldsFromManifest({
      code: 'demo',
      name: 'Demo',
      version: '1.0.1',
      scopes: ['people:read'],
    });
    expect(fields).not.toHaveProperty('websiteUrl');
    expect(fields).not.toHaveProperty('privacyUrl');
    expect(fields).not.toHaveProperty('screenshots');
    expect(fields).not.toHaveProperty('webhookUrl');
    expect(fields.name).toBe('Demo');
  });

  it('updates listing and webhook fields when the manifest sets them', () => {
    const fields = appFieldsFromManifest({
      code: 'demo',
      name: 'Demo',
      version: '1.0.1',
      websiteUrl: 'https://example.com',
      privacyUrl: 'https://example.com/privacy',
      screenshots: ['https://example.com/a.png'],
      webhookUrl: 'https://example.com/hooks',
    });
    expect(fields.websiteUrl).toBe('https://example.com');
    expect(fields.privacyUrl).toBe('https://example.com/privacy');
    expect(fields.screenshots).toEqual(['https://example.com/a.png']);
    expect(fields.webhookUrl).toBe('https://example.com/hooks');
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
