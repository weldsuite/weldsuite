import { describe, it, expect } from 'vitest';
import {
  isAuthWebhook,
  isSyncWebhook,
  parseNangoWebhook,
  signPayload,
  verifyNangoSignature,
} from './webhooks';

const SECRET = 'nango-secret-key';

describe('verifyNangoSignature', () => {
  it('accepts a signature computed over the raw body', async () => {
    const body = JSON.stringify({ type: 'sync', connectionId: 'c1', providerConfigKey: 'hubspot' });
    const signature = await signPayload(SECRET, body);
    await expect(verifyNangoSignature(SECRET, body, signature)).resolves.toBe(true);
  });

  it('accepts an uppercase signature header', async () => {
    const body = '{"type":"auth","connectionId":"c1","providerConfigKey":"hubspot"}';
    const signature = (await signPayload(SECRET, body)).toUpperCase();
    await expect(verifyNangoSignature(SECRET, body, signature)).resolves.toBe(true);
  });

  it('accepts a signature computed over re-serialised JSON', async () => {
    // Nango hashes JSON.stringify(body); the bytes on the wire may carry
    // formatting the signer never saw.
    const wire = '{\n  "type": "sync",\n  "connectionId": "c1",\n  "providerConfigKey": "hubspot"\n}';
    const canonical = JSON.stringify(JSON.parse(wire));
    const signature = await signPayload(SECRET, canonical);
    await expect(verifyNangoSignature(SECRET, wire, signature)).resolves.toBe(true);
  });

  it('rejects a tampered body', async () => {
    const body = JSON.stringify({ type: 'sync', connectionId: 'c1', providerConfigKey: 'hubspot' });
    const signature = await signPayload(SECRET, body);
    const tampered = JSON.stringify({ type: 'sync', connectionId: 'c2', providerConfigKey: 'hubspot' });
    await expect(verifyNangoSignature(SECRET, tampered, signature)).resolves.toBe(false);
  });

  it('rejects a signature made with a different secret', async () => {
    const body = '{"type":"sync","connectionId":"c1","providerConfigKey":"hubspot"}';
    const signature = await signPayload('other-secret', body);
    await expect(verifyNangoSignature(SECRET, body, signature)).resolves.toBe(false);
  });

  it('fails closed when the secret or header is missing', async () => {
    const body = '{"type":"sync"}';
    const signature = await signPayload(SECRET, body);
    await expect(verifyNangoSignature(undefined, body, signature)).resolves.toBe(false);
    await expect(verifyNangoSignature(SECRET, body, null)).resolves.toBe(false);
    await expect(verifyNangoSignature(SECRET, body, '')).resolves.toBe(false);
  });
});

describe('parseNangoWebhook', () => {
  it('parses an auth webhook and narrows it', () => {
    const payload = parseNangoWebhook(
      JSON.stringify({
        type: 'auth',
        from: 'nango',
        operation: 'creation',
        connectionId: 'conn-1',
        providerConfigKey: 'salesforce',
        success: true,
        endUser: { endUserId: 'user_1', organizationId: 'org_1' },
      }),
    );

    expect(payload).not.toBeNull();
    expect(isAuthWebhook(payload!)).toBe(true);
    expect(isSyncWebhook(payload!)).toBe(false);
  });

  it('parses a sync webhook', () => {
    const payload = parseNangoWebhook(
      JSON.stringify({
        type: 'sync',
        from: 'nango',
        connectionId: 'conn-1',
        providerConfigKey: 'hubspot',
        syncName: 'hubspot-contacts',
        model: 'HubspotContact',
        success: true,
        responseResults: { added: 3, updated: 1, deleted: 0 },
      }),
    );

    expect(payload).not.toBeNull();
    expect(isSyncWebhook(payload!)).toBe(true);
  });

  it('returns null for malformed JSON, unknown types and missing identifiers', () => {
    expect(parseNangoWebhook('not json')).toBeNull();
    expect(parseNangoWebhook('null')).toBeNull();
    expect(
      parseNangoWebhook(JSON.stringify({ type: 'unknown', connectionId: 'c', providerConfigKey: 'p' })),
    ).toBeNull();
    expect(parseNangoWebhook(JSON.stringify({ type: 'sync', providerConfigKey: 'p' }))).toBeNull();
  });
});
