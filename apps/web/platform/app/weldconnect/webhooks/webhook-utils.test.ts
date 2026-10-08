import { describe, expect, it } from 'vitest';
import {
  SIGNATURE_PLACEHOLDER,
  buildWebhookCurl,
  deriveWebhookStatus,
  eventStatusTone,
  webhookDisplayName,
} from './webhook-utils';

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

describe('deriveWebhookStatus', () => {
  it('follows the workflow: only a published workflow answers calls', () => {
    expect(deriveWebhookStatus({ isEnabled: true, workflowStatus: 'active' })).toBe('active');
    expect(deriveWebhookStatus({ isEnabled: true, workflowStatus: 'paused' })).toBe('paused');
    expect(deriveWebhookStatus({ isEnabled: true, workflowStatus: 'draft' })).toBe('draft');
    expect(deriveWebhookStatus({ isEnabled: true, workflowStatus: 'archived' })).toBe('archived');
  });

  it('treats a missing workflow status as a draft', () => {
    expect(deriveWebhookStatus({ isEnabled: true })).toBe('draft');
    expect(deriveWebhookStatus({ isEnabled: true, workflowStatus: null })).toBe('draft');
  });

  it('shows a switched-off webhook as disabled whatever the workflow does', () => {
    expect(deriveWebhookStatus({ isEnabled: false, workflowStatus: 'active' })).toBe('disabled');
  });
});

describe('webhookDisplayName', () => {
  it('shows the workflow name for the default "Webhook" name', () => {
    expect(webhookDisplayName({ name: 'Webhook', workflowName: 'Order intake' })).toBe('Order intake');
    expect(webhookDisplayName({ name: ' webhook ', workflowName: 'Order intake' })).toBe('Order intake');
    expect(webhookDisplayName({ name: 'Webhook Trigger', workflowName: 'Order intake' })).toBe('Order intake');
    expect(webhookDisplayName({ name: '', workflowName: 'Order intake' })).toBe('Order intake');
  });

  it('keeps a name someone chose', () => {
    expect(webhookDisplayName({ name: 'Shopify orders', workflowName: 'Order intake' })).toBe('Shopify orders');
  });

  it('falls back to the stored name when there is no workflow', () => {
    expect(webhookDisplayName({ name: 'Webhook', workflowName: null })).toBe('Webhook');
    expect(webhookDisplayName({ name: null, workflowName: null })).toBe('');
  });
});
