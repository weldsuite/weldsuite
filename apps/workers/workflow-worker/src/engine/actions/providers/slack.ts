/**
 * Slack outbound actions (`slack.*`).
 */

import type { ActionHandler } from '../../types';
import { getValidIntegrationToken } from './token';

/** Post a message to a Slack channel via chat.postMessage. */
export const handleSlackPostMessage: ActionHandler = async (inputs, ctx) => {
  const channel = String(inputs.channel || '');
  const text = String(inputs.text || '');
  if (!channel) throw new Error('Slack channel is required');
  if (!text) throw new Error('Slack message text is required');

  const { accessToken } = await getValidIntegrationToken(ctx, {
    type: 'slack',
    integrationId: inputs.integrationId ? String(inputs.integrationId) : undefined,
  });

  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, text }),
  });

  const result = (await response.json()) as { ok: boolean; ts?: string; channel?: string; error?: string };
  if (!result.ok) throw new Error(`Slack error: ${result.error || 'unknown'}`);
  return { sent: true, channel: result.channel ?? channel, ts: result.ts };
};
