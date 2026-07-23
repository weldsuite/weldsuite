/**
 * send_sms — sends an SMS via Telnyx.
 */

import type { ActionHandler } from '../types';

export const handleSendSms: ActionHandler = async (inputs, ctx) => {
  const to = String(inputs.to || inputs.phoneNumber || '');
  const body = String(inputs.body || inputs.message || '');
  if (!to) throw new Error('Phone number is required');
  if (!body) throw new Error('Message body is required');

  const apiKey = ctx.env.TELNYX_API_KEY;
  if (!apiKey) throw new Error('TELNYX_API_KEY not configured');

  const from = inputs.from ? String(inputs.from) : undefined;
  const messagingProfileId = inputs.messagingProfileId ? String(inputs.messagingProfileId) : undefined;

  const res = await fetch('https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to,
      text: body,
      ...(from ? { from } : {}),
      ...(messagingProfileId ? { messaging_profile_id: messagingProfileId } : {}),
    }),
  });

  const data = (await res.json().catch(() => ({}))) as { data?: { id?: string } };
  if (!res.ok) throw new Error(`SMS send failed: ${res.status}`);
  return { sent: true, id: data?.data?.id, status: 'queued' };
};
