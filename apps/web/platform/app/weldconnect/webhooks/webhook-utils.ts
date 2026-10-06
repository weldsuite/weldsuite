/**
 * Helpers for the webhook detail page.
 */

/** Placeholder for the signature in the cURL example; the real value is computed per request. */
export const SIGNATURE_PLACEHOLDER = '<hex HMAC-SHA256 of the body>';

/**
 * Example request for a webhook. The receiver only accepts POST; when the
 * webhook requires a signature it is the HMAC-SHA256 of the raw body, keyed
 * with the webhook's secret, in the configured header. The secret itself is
 * never sent.
 */
export function buildWebhookCurl(
  url: string,
  options: { validateSignature: boolean; signatureHeader?: string | null },
): string {
  const lines = [`curl -X POST ${url}`, '  -H "Content-Type: application/json"'];
  if (options.validateSignature) {
    lines.push(`  -H "${options.signatureHeader || 'x-webhook-signature'}: ${SIGNATURE_PLACEHOLDER}"`);
  }
  lines.push(`  -d '{"test": true}'`);
  return lines.join(' \\\n');
}

export type EventTone = 'success' | 'failed' | 'pending' | 'neutral';

/** Badge colour for a webhook event, which is the status of the run it started. */
export function eventStatusTone(status: string): EventTone {
  switch (status) {
    case 'completed':
    case 'success':
      return 'success';
    case 'failed':
    case 'timeout':
      return 'failed';
    case 'queued':
    case 'pending':
    case 'running':
    case 'waiting_for_input':
      return 'pending';
    default:
      return 'neutral';
  }
}
