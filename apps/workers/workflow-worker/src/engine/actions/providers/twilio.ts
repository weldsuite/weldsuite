/**
 * Twilio outbound action (`twilio.send_sms`).
 */

import type { ActionHandler } from '../../types';
import { getIntegrationCredentials } from './token';

export const handleTwilioSendSms: ActionHandler = async (inputs, ctx) => {
  const to = String(inputs.to || '');
  const body = String(inputs.body || '');
  if (!to) throw new Error('Twilio recipient (to) is required');
  if (!body) throw new Error('Twilio message body is required');

  const { credentials } = await getIntegrationCredentials(ctx, {
    type: 'twilio',
    integrationId: inputs.integrationId ? String(inputs.integrationId) : undefined,
  });
  const sid = credentials.accountSid;
  const authToken = credentials.authToken;
  const from = inputs.from ? String(inputs.from) : credentials.fromNumber;
  if (!sid || !authToken) throw new Error('Twilio Account SID / Auth Token missing');
  if (!from) throw new Error('Twilio "from" number missing (set a default or pass one)');

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${sid}:${authToken}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  const json = (await res.json()) as { sid?: string; error_message?: string };
  if (!res.ok) throw new Error(`Twilio send failed: ${json.error_message || res.status}`);
  return { sent: true, messageSid: json.sid };
};
