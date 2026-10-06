import { describe, expect, it } from 'vitest';
import { SIGNATURE_PLACEHOLDER, buildWebhookCurl, eventStatusTone } from './webhook-utils';

describe('buildWebhookCurl', () => {
  it('posts JSON without a signature header when signing is off', () => {
    const curl = buildWebhookCurl('https://connect-api.example/api/workflows/webhook/wh_1', { validateSignature: false });
    expect(curl).toBe(
      'curl -X POST https://connect-api.example/api/workflows/webhook/wh_1 \\\n' +
        '  -H "Content-Type: application/json" \\\n' +
        `  -d '{"test": true}'`,
    );
  });

  it('adds the configured signature header with a placeholder, never a secret', () => {
    const curl = buildWebhookCurl('https://x/wh', { validateSignature: true, signatureHeader: 'x-signature' });
    expect(curl).toContain(`-H "x-signature: ${SIGNATURE_PLACEHOLDER}"`);
    const fallback = buildWebhookCurl('https://x/wh', { validateSignature: true, signatureHeader: null });
    expect(fallback).toContain('-H "x-webhook-signature: ');
  });
});

describe('eventStatusTone', () => {
  it('maps run statuses onto badge tones', () => {
    expect(eventStatusTone('completed')).toBe('success');
    expect(eventStatusTone('failed')).toBe('failed');
    expect(eventStatusTone('timeout')).toBe('failed');
    expect(eventStatusTone('running')).toBe('pending');
    expect(eventStatusTone('queued')).toBe('pending');
    expect(eventStatusTone('cancelled')).toBe('neutral');
  });
});
