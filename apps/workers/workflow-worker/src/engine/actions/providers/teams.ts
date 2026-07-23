/**
 * Microsoft Teams outbound action (`teams.post_message`) — posts a MessageCard
 * to the connection's incoming webhook URL.
 */

import type { ActionHandler } from '../../types';
import { getIntegrationCredentials } from './token';

export const handleTeamsPostMessage: ActionHandler = async (inputs, ctx) => {
  const text = String(inputs.text || '');
  if (!text) throw new Error('Teams message text is required');

  const { credentials } = await getIntegrationCredentials(ctx, {
    type: 'teams',
    integrationId: inputs.integrationId ? String(inputs.integrationId) : undefined,
  });
  const webhookUrl = credentials.webhookUrl;
  if (!webhookUrl) throw new Error('Teams integration has no webhook URL');

  const title = inputs.title ? String(inputs.title) : undefined;
  const card = {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    summary: title || 'WeldConnect notification',
    ...(title ? { title } : {}),
    text,
  };

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(card),
  });
  if (!res.ok) throw new Error(`Teams post failed: ${res.status} - ${await res.text()}`);
  return { sent: true };
};
