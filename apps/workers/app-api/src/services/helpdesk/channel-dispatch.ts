/**
 * Channel dispatch — unified outbound routing for WeldDesk agent replies.
 *
 * Ported from api-worker `src/services/channel-dispatch.ts` (W5b legacy-worker
 * phase-out). Routes an agent/system reply to the external channel the
 * conversation came in on:
 *   - chat    → nothing to do (realtime already delivered it to the widget)
 *   - discord → Discord Bot API
 *   - email   → Cloudflare send_email binding, with RFC threading headers
 *   - slack   → Slack Web API (chat.postMessage), threaded when we have a ts
 *
 * Dispatch is best-effort: every failure is logged, never thrown. The message
 * is already persisted by the time we get here, so a dead external channel must
 * not fail the agent's request.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { sendMessage as sendDiscordMessage } from '../../lib/discord';
import { schema, type Database } from '../../db';
import type { Env } from '../../types';

// `lib/cloudflare-email` statically imports `cloudflare:email`, a Workers
// runtime built-in that a node/vitest module graph cannot resolve. Importing it
// eagerly here would drag it into `routes/conversations`, breaking the three
// test files that mount that router (integration + the two shared route
// sweeps). Loading it only on the email branch keeps the route importable
// off-edge; wrangler still bundles it for the Worker.
async function loadSendEmail() {
  const { sendEmail } = await import('../../lib/cloudflare-email');
  return sendEmail;
}

export interface DispatchConversation {
  id: string;
  channel: string | null;
  subject: string;
  customerEmail: string | null;
  metadata: Record<string, unknown> | null;
}

export interface DispatchMessage {
  id: string;
  content: string;
  contentHtml?: string;
  authorName?: string;
  isInternal?: boolean;
}

/**
 * Dispatch an outbound message to the appropriate external channel.
 *
 * Returns silently for internal notes (never leak a note to the customer) and
 * for the chat channel (realtime already handled it).
 */
export async function dispatchOutbound(
  env: Env,
  db: Database,
  conversation: DispatchConversation,
  message: DispatchMessage,
): Promise<void> {
  if (message.isInternal) return;

  const channel = conversation.channel || 'chat';

  switch (channel) {
    case 'chat':
      return;
    case 'discord':
      return dispatchDiscord(env, conversation, message);
    case 'email':
      return dispatchEmail(env, db, conversation, message);
    case 'slack':
      return dispatchSlack(db, conversation, message);
    default:
      console.warn(
        `[ChannelDispatch] Unknown channel "${channel}" for conversation ${conversation.id}`,
      );
  }
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

async function dispatchDiscord(
  env: Env,
  conversation: DispatchConversation,
  message: DispatchMessage,
): Promise<void> {
  const discordChannelId = conversation.metadata?.discordChannelId as string | undefined;

  if (!discordChannelId || !env.DISCORD_BOT_TOKEN) {
    console.warn(
      `[ChannelDispatch:Discord] Missing channelId or bot token for conversation ${conversation.id}`,
    );
    return;
  }

  try {
    await sendDiscordMessage(env.DISCORD_BOT_TOKEN, discordChannelId, message.content);
  } catch (err) {
    console.error('[ChannelDispatch:Discord] Failed to send message:', err);
  }
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

async function dispatchEmail(
  env: Env,
  db: Database,
  conversation: DispatchConversation,
  message: DispatchMessage,
): Promise<void> {
  const metadata = conversation.metadata;
  const helpdeskEmailAddress = metadata?.helpdeskEmailAddress as string | undefined;
  const customerEmail = conversation.customerEmail;

  if (!helpdeskEmailAddress || !customerEmail) {
    console.warn(
      `[ChannelDispatch:Email] Missing email addresses for conversation ${conversation.id}`,
    );
    return;
  }

  try {
    const agentName = message.authorName || 'Support';
    const fromAddress = `"${agentName}" <${helpdeskEmailAddress}>`;

    // RFC 5322 threading so the reply lands in the customer's existing thread.
    const headers: Record<string, string> = {};
    const lastEmailMessageId = metadata?.lastEmailMessageId as string | undefined;
    const emailReferences = (metadata?.emailReferences as string[]) || [];

    if (lastEmailMessageId) headers['In-Reply-To'] = lastEmailMessageId;
    if (emailReferences.length > 0) headers['References'] = emailReferences.join(' ');

    const subject = conversation.subject.startsWith('Re:')
      ? conversation.subject
      : `Re: ${conversation.subject}`;

    const sendEmail = await loadSendEmail();
    const result = await sendEmail(env, {
      from: fromAddress,
      to: [customerEmail],
      subject,
      html: message.contentHtml || undefined,
      text: message.content,
      headers,
    });

    const sentMessageId = result.messageId;

    await db
      .update(schema.helpdeskConversationMessages)
      .set({
        metadata: {
          emailMessageId: sentMessageId,
          emailFrom: helpdeskEmailAddress,
          emailTo: [customerEmail],
          emailSubject: subject,
        },
      })
      .where(eq(schema.helpdeskConversationMessages.id, message.id));

    // Keep the last 50 Message-IDs so the References header stays bounded.
    const updatedReferences = [...emailReferences, sentMessageId].slice(-50);
    await db
      .update(schema.helpdeskConversations)
      .set({
        metadata: {
          ...metadata,
          lastEmailMessageId: sentMessageId,
          emailReferences: updatedReferences,
        },
      })
      .where(eq(schema.helpdeskConversations.id, conversation.id));
  } catch (err) {
    console.error('[ChannelDispatch:Email] Failed to send:', err);
  }
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

async function dispatchSlack(
  db: Database,
  conversation: DispatchConversation,
  message: DispatchMessage,
): Promise<void> {
  const metadata = conversation.metadata;
  const slackChannelId = metadata?.slackChannelId as string | undefined;
  const slackThreadTs = metadata?.slackThreadTs as string | undefined;

  if (!slackChannelId) {
    console.warn(
      `[ChannelDispatch:Slack] Missing slackChannelId for conversation ${conversation.id}`,
    );
    return;
  }

  const [integration] = await db
    .select()
    .from(schema.helpdeskChannelIntegrations)
    .where(
      and(
        eq(schema.helpdeskChannelIntegrations.provider, 'slack'),
        isNull(schema.helpdeskChannelIntegrations.deletedAt),
      ),
    )
    .limit(1);

  if (!integration || integration.status !== 'connected') {
    console.warn(
      `[ChannelDispatch:Slack] No active Slack integration for conversation ${conversation.id}`,
    );
    return;
  }

  const config = (integration.config || {}) as Record<string, unknown>;
  const botToken = config.botToken as string | undefined;

  if (!botToken) {
    console.warn('[ChannelDispatch:Slack] No bot token in Slack integration config');
    return;
  }

  try {
    const body: Record<string, unknown> = {
      channel: slackChannelId,
      text: message.content,
    };
    if (slackThreadTs) body.thread_ts = slackThreadTs;

    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const result = (await response.json()) as { ok: boolean; error?: string };
    if (!result.ok) {
      console.error(`[ChannelDispatch:Slack] API error: ${result.error}`);
    }
  } catch (err) {
    console.error('[ChannelDispatch:Slack] Failed to send message:', err);
  }
}
