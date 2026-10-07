/**
 * Gmail outbound action (`gmail.send_email`) — see "Provider pattern" in
 * docs/plans/weldconnect.md. Uses the shared Google token (./token.ts,
 * refreshed automatically) and the engine's existing recipient validation
 * (actions/communication.ts) and plain-text escaping (resolve-inputs.ts) so
 * Gmail sends behave exactly like the WeldSuite `send_email` action: every
 * resolved address is checked before anything is sent, and an unresolved
 * `{{variable}}` never reaches Gmail as a literal string.
 */

import type { ActionHandler } from '../../types';
import { NonRetryableStepError } from '../../errors';
import { isValidRecipient } from '../communication';
import { escapeHtml } from '../../resolve-inputs';
import { getValidIntegrationToken } from './token';
import { throwGoogleApiError } from './google-errors';

/** Split a resolved recipient field (comma/semicolon list) into trimmed, non-empty entries. */
function splitRecipients(value: unknown): string[] {
  const items = typeof value === 'string' ? value.split(/[,;]/) : [];
  return items.map((item) => item.trim()).filter(Boolean);
}

/** Validated recipients for one field — never sends to an address that doesn't look like one. */
function validatedRecipients(value: unknown, field: 'To' | 'Cc' | 'Bcc', required: boolean): string[] {
  const recipients = splitRecipients(value);
  if (recipients.length === 0) {
    if (required) throw new NonRetryableStepError(`No recipient address: "${field}" resolved to an empty value`);
    return [];
  }
  const invalid = recipients.find((r) => !isValidRecipient(r));
  if (invalid !== undefined) {
    throw new NonRetryableStepError(`Recipient address "${invalid}" is not valid` + (field === 'To' ? '' : ` (${field})`));
  }
  return recipients;
}

/** Base64url-encode a UTF-8 string (Gmail `raw` requires URL-safe base64). */
function base64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 2047-ish escaping is unnecessary for ASCII headers; this only guards
 *  against header injection via newlines in a resolved `{{variable}}`. */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export const handleGmailSendEmail: ActionHandler = async (inputs, ctx) => {
  const toRecipients = validatedRecipients(inputs.to, 'To', true);
  const ccRecipients = validatedRecipients(inputs.cc, 'Cc', false);
  const bccRecipients = validatedRecipients(inputs.bcc, 'Bcc', false);

  const subject = sanitizeHeaderValue(String(inputs.subject ?? ''));
  if (!subject) throw new NonRetryableStepError('Gmail subject is required');

  // Mirrors handleSendEmail's convention (actions/communication.ts): off (or
  // unset) is HTML, `isHtml: false` is the editor's "Plain text" tab — escape
  // it and keep its line breaks instead of collapsing them.
  const rawBody = String(inputs.body ?? '');
  if (!rawBody.trim()) throw new NonRetryableStepError('Gmail body is required');
  const isPlainText = inputs.isHtml === false;
  const html = isPlainText ? escapeHtml(rawBody).replace(/\r?\n/g, '<br>') : rawBody;

  const { accessToken } = await getValidIntegrationToken(ctx, {
    type: 'gmail',
    integrationId: inputs.integrationId ? String(inputs.integrationId) : undefined,
  });

  const headers = [
    `To: ${toRecipients.join(', ')}`,
    ccRecipients.length ? `Cc: ${ccRecipients.join(', ')}` : '',
    bccRecipients.length ? `Bcc: ${bccRecipients.join(', ')}` : '',
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
  ].filter(Boolean);
  const raw = base64Url(`${headers.join('\r\n')}\r\n\r\n${html}`);

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) await throwGoogleApiError(res, 'Gmail send');
  const json = (await res.json()) as { id?: string; threadId?: string };
  return { ok: true, id: json.id, threadId: json.threadId };
};
