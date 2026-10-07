/**
 * Slack outbound actions (`slack.*`) — the reference third-party provider.
 * Google (Sheets, Gmail, Calendar) and GitHub follow the same shape; see
 * "Provider pattern" in docs/plans/weldconnect.md.
 */

import type { ActionHandler } from '../../types';
import { NonRetryableStepError } from '../../errors';
import { getValidIntegrationToken } from './token';
import { asText } from '@weldsuite/text';

interface SlackPostMessageResponse {
  ok: boolean;
  error?: string;
  channel?: string;
  ts?: string;
}

/**
 * Slack error codes that will not resolve on retry: bad config (channel) or a
 * dead connection. Everything else (unlisted codes, 5xx) is left retryable —
 * the step's own retry policy decides whether to try again.
 * https://api.slack.com/methods/chat.postMessage#errors
 */
const NON_RETRYABLE_SLACK_ERRORS: Record<string, string> = {
  channel_not_found:
    'Slack channel not found — it may have been deleted, archived, or the id/name is wrong.',
  not_in_channel:
    "WeldSuite's Slack app hasn't been invited to this channel yet. Invite it from Slack (/invite @WeldSuite) and try again — private channels always need this.",
  is_archived: 'This Slack channel is archived and no longer accepts messages.',
  msg_too_long: 'The Slack message is too long (over 40,000 characters).',
  no_text: 'Slack message text is required.',
  invalid_auth: 'The Slack connection is no longer valid. Reconnect it from WeldConnect → Integrations.',
  account_inactive: 'The Slack connection is no longer valid. Reconnect it from WeldConnect → Integrations.',
  token_revoked: 'The Slack connection was revoked. Reconnect it from WeldConnect → Integrations.',
  not_authed: 'The Slack connection is no longer valid. Reconnect it from WeldConnect → Integrations.',
  missing_scope: 'The Slack connection is missing a required permission scope. Reconnect it from WeldConnect → Integrations.',
};

/** A retryable failure that keeps the provider's raw payload for the step row. */
class RetryableProviderError extends Error {
  readonly details?: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.name = 'RetryableProviderError';
    this.details = details;
  }
}

/** Best-effort permalink for the posted message — never fails the step. */
async function fetchPermalink(accessToken: string, channel: string, ts: string): Promise<string | undefined> {
  try {
    const params = new URLSearchParams({ channel, message_ts: ts });
    const res = await fetch(`https://slack.com/api/chat.getPermalink?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const json = (await res.json()) as { ok: boolean; permalink?: string };
    return json.ok ? json.permalink : undefined;
  } catch {
    return undefined;
  }
}

/** Post a message to a Slack channel via chat.postMessage. */
export const handleSlackPostMessage: ActionHandler = async (inputs, ctx) => {
  const channel = asText(inputs.channel || '').trim();
  const text = asText(inputs.text || '');
  const threadTs = inputs.threadTs ? String(inputs.threadTs).trim() : undefined;
  if (!channel) throw new NonRetryableStepError('Slack channel is required');
  if (!text.trim()) throw new NonRetryableStepError('Slack message text is required');

  const { accessToken } = await getValidIntegrationToken(ctx, {
    type: 'slack',
    integrationId: inputs.integrationId ? asText(inputs.integrationId) : undefined,
  });

  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    }),
  });

  if (response.status === 429) {
    const retryAfterSeconds = Number(response.headers.get('retry-after')) || undefined;
    throw new RetryableProviderError(
      `Slack is rate-limiting this workspace${retryAfterSeconds ? ` — retry after ${retryAfterSeconds}s` : ''}`,
      { retryAfterSeconds },
    );
  }

  const result = (await response.json()) as SlackPostMessageResponse;
  if (!result.ok) {
    const code = result.error || 'unknown';
    const mapped = NON_RETRYABLE_SLACK_ERRORS[code];
    if (mapped) throw new NonRetryableStepError(mapped, { slackError: code });
    if (code === 'ratelimited') {
      throw new RetryableProviderError('Slack is rate-limiting this workspace', { slackError: code });
    }
    // Unmapped codes are treated like any other application error from the
    // provider: the request itself is the problem, so retrying it unchanged
    // will not help (mirrors the 4xx handling in actions/http.ts).
    throw new NonRetryableStepError(`Slack error: ${code}`, { slackError: code });
  }

  const resolvedChannel = result.channel ?? channel;
  const permalink =
    result.ts && resolvedChannel ? await fetchPermalink(accessToken, resolvedChannel, result.ts) : undefined;

  return { ok: true, channel: resolvedChannel, ts: result.ts, permalink };
};
