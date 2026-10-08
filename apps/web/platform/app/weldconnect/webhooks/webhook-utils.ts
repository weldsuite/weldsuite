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

/**
 * The state a webhook is really in. The receiver only accepts calls while its
 * workflow is published (`active`), so a webhook that is switched on still
 * answers 404 for a draft or paused workflow: the status follows the workflow.
 */
export type WebhookStatus = 'active' | 'draft' | 'paused' | 'archived' | 'disabled';

export function deriveWebhookStatus(webhook: {
  isEnabled: boolean;
  workflowStatus?: string | null;
}): WebhookStatus {
  if (!webhook.isEnabled) return 'disabled';
  switch ((webhook.workflowStatus ?? '').toLowerCase()) {
    case 'active':
      return 'active';
    case 'paused':
      return 'paused';
    case 'archived':
      return 'archived';
    default:
      return 'draft';
  }
}

/** The names a webhook gets when nobody named it (see routes/workflow-webhooks). */
const GENERIC_WEBHOOK_NAMES = new Set(['webhook', 'webhook trigger']);

/**
 * Name to show for a webhook. The API names every provisioned webhook just
 * "Webhook", which makes a list of them indistinguishable: fall back to the
 * workflow's name, and keep any name a person chose.
 */
export function webhookDisplayName(webhook: { name?: string | null; workflowName?: string | null }): string {
  const name = webhook.name?.trim() ?? '';
  const workflowName = webhook.workflowName?.trim() ?? '';
  if (workflowName && (!name || GENERIC_WEBHOOK_NAMES.has(name.toLowerCase()))) return workflowName;
  return name || workflowName;
}
