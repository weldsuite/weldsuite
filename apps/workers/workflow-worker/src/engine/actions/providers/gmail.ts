/**
 * Gmail outbound action (`gmail.send_email`). Uses the shared Google token.
 */

import type { ActionHandler } from '../../types';
import { getValidIntegrationToken } from './token';

/** Base64url-encode a UTF-8 string (Gmail `raw` requires URL-safe base64). */
function base64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const handleGmailSendEmail: ActionHandler = async (inputs, ctx) => {
  const to = String(inputs.to || '');
  const subject = String(inputs.subject || '');
  const body = String(inputs.body || '');
  if (!to) throw new Error('Gmail recipient (to) is required');
  if (!subject) throw new Error('Gmail subject is required');

  const { accessToken } = await getValidIntegrationToken(ctx, {
    type: 'gmail',
    integrationId: inputs.integrationId ? String(inputs.integrationId) : undefined,
  });

  const headers = [
    `To: ${to}`,
    inputs.cc ? `Cc: ${String(inputs.cc)}` : '',
    inputs.bcc ? `Bcc: ${String(inputs.bcc)}` : '',
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
  ].filter(Boolean);
  const raw = base64Url(`${headers.join('\r\n')}\r\n\r\n${body}`);

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) throw new Error(`Gmail send failed: ${res.status} - ${await res.text()}`);
  const json = (await res.json()) as { id?: string; threadId?: string };
  return { sent: true, id: json.id, threadId: json.threadId };
};
