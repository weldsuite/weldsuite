/**
 * Channel Dispatch — Sends workflow-produced messages to external channels.
 *
 * When a workflow step creates a customer-facing message (e.g., send_choices,
 * trigger_csat), this module dispatches it to the appropriate external channel
 * (Slack, Discord) with proper formatting (Block Kit, embeds + buttons).
 *
 * Only called for non-widget channels — widget messages are delivered via the
 * realtime refetch hint.
 */

import { eq, and, isNull } from 'drizzle-orm';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as schema from '@weldsuite/db/schema';
import type { Env } from '../types';

type Database = NeonHttpDatabase<typeof schema>;

const DISCORD_API = 'https://discord.com/api/v10';

interface DispatchContext {
  db: Database;
  env: Env;
  conversationId: string;
  workspaceId: string;
  channel: string;
  stepType: string;
  stepResult: Record<string, unknown>;
}

/**
 * Dispatch a workflow step's output message to an external channel.
 * No-op for 'chat' or 'web' channels (handled by realtime refetch).
 */
export async function dispatchStepToChannel(ctx: DispatchContext): Promise<void> {
  if (ctx.channel === 'chat' || ctx.channel === 'web' || ctx.channel === 'email') return;

  try {
    if (ctx.channel === 'discord') {
      await dispatchToDiscord(ctx);
    } else if (ctx.channel === 'slack') {
      await dispatchToSlack(ctx);
    }
  } catch (err) {
    console.error(`[ChannelDispatch] Failed to dispatch ${ctx.stepType} to ${ctx.channel}:`, err);
  }
}

// ============================================================================
// Discord Dispatch
// ============================================================================

async function dispatchToDiscord(ctx: DispatchContext): Promise<void> {
  const botToken = ctx.env.DISCORD_BOT_TOKEN;
  if (!botToken) {
    console.warn('[ChannelDispatch:Discord] No DISCORD_BOT_TOKEN configured');
    return;
  }

  // Look up conversation metadata for Discord channel/thread ID
  const [conversation] = await ctx.db
    .select({ metadata: schema.helpdeskConversations.metadata })
    .from(schema.helpdeskConversations)
    .where(eq(schema.helpdeskConversations.id, ctx.conversationId))
    .limit(1);

  if (!conversation?.metadata) return;

  const metadata = conversation.metadata as Record<string, unknown>;
  const discordChannelId = metadata.discordChannelId as string | undefined;
  if (!discordChannelId) return;

  const result = ctx.stepResult;
  const text = (result.content || result.message || result.aiContent || '') as string;

  // Build message payload based on step type
  const body: Record<string, unknown> = {};

  switch (ctx.stepType) {
    case 'send_choices': {
      const options = (result.options || []) as Array<{ id: string; label: string; value: string }>;
      const stepId = (result.stepId || result.messageId || '') as string;

      body.embeds = [{
        description: text || 'Please select an option:',
        color: 0x5865F2,
      }];
      body.components = [{
        type: 1, // ACTION_ROW
        components: options.slice(0, 5).map((opt) => ({
          type: 2, // BUTTON
          style: 1, // PRIMARY
          label: opt.label.slice(0, 80),
          custom_id: `wf_choice:${ctx.conversationId}:${stepId}:${opt.value}`,
        })),
      }];
      break;
    }

    case 'trigger_csat': {
      const stepId = (result.stepId || result.messageId || '') as string;

      body.embeds = [{
        description: text || 'How would you rate your experience?',
        color: 0x5865F2,
      }];
      body.components = [{
        type: 1, // ACTION_ROW
        components: [1, 2, 3, 4, 5].map((rating) => ({
          type: 2, // BUTTON
          style: rating <= 2 ? 4 : rating === 3 ? 2 : 3, // DANGER / SECONDARY / SUCCESS
          label: `${rating}`,
          custom_id: `wf_csat:${ctx.conversationId}:${stepId}:${rating}`,
        })),
      }];
      break;
    }

    case 'collect_input':
    case 'collect_customer_info': {
      const fields = (result.fields || []) as Array<{ label: string; required?: boolean }>;
      const fieldList = fields.map((f) => `${f.required ? '**' : ''}${f.label}${f.required ? '**' : ''}`).join('\n- ');

      body.embeds = [{
        description: text || 'Please provide the following information:',
        fields: [{
          name: 'Required information',
          value: `- ${fieldList}`,
        }],
        footer: { text: 'Please reply in this thread with the requested details.' },
        color: 0x5865F2,
      }];
      break;
    }

    case 'suggest_articles': {
      const articles = (result.articles || []) as Array<{ title: string; slug?: string; url?: string }>;
      if (articles.length === 0 && !text) return;

      const articleList = articles.map((a) => `- ${a.title}`).join('\n');

      body.embeds = [{
        title: 'Suggested Articles',
        description: text ? `${text}\n\n${articleList}` : articleList,
        color: 0x5865F2,
      }];
      break;
    }

    default: {
      // Plain message (send_message, ai_auto_reply, etc.)
      if (!text) return;
      body.content = text;
      break;
    }
  }

  // Send to Discord
  try {
    const response = await fetch(`${DISCORD_API}/channels/${discordChannelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[ChannelDispatch:Discord] API error (${response.status}): ${errText}`);
    } else {
      console.log(`[ChannelDispatch:Discord] Step ${ctx.stepType} dispatched to ${discordChannelId}`);
    }
  } catch (err) {
    console.error(`[ChannelDispatch:Discord] Failed to send:`, err);
  }
}

// ============================================================================
// Slack Dispatch
// ============================================================================

async function dispatchToSlack(ctx: DispatchContext): Promise<void> {
  const [conversation] = await ctx.db
    .select({ metadata: schema.helpdeskConversations.metadata })
    .from(schema.helpdeskConversations)
    .where(eq(schema.helpdeskConversations.id, ctx.conversationId))
    .limit(1);

  if (!conversation?.metadata) return;

  const metadata = conversation.metadata as Record<string, unknown>;
  const slackChannelId = metadata.slackChannelId as string | undefined;
  const slackThreadTs = metadata.slackThreadTs as string | undefined;

  if (!slackChannelId) return;

  // Look up Slack bot token from integration config
  const [integration] = await ctx.db
    .select()
    .from(schema.helpdeskChannelIntegrations)
    .where(
      and(
        eq(schema.helpdeskChannelIntegrations.provider, 'slack'),
        isNull(schema.helpdeskChannelIntegrations.deletedAt),
      ),
    )
    .limit(1);

  if (!integration || integration.status !== 'connected') return;

  const config = (integration.config || {}) as Record<string, unknown>;
  const botToken = config.botToken as string | undefined;
  if (!botToken) return;

  const result = ctx.stepResult;
  let text = (result.content || result.message || '') as string;
  let blocks: unknown[] | undefined;

  switch (ctx.stepType) {
    case 'send_choices': {
      const options = (result.options || []) as Array<{ id: string; label: string; value: string }>;
      const stepId = (result.stepId || '') as string;

      blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: text || 'Please select an option:' } },
        {
          type: 'actions',
          block_id: `wf_choices_${stepId}`,
          elements: options.map((opt) => ({
            type: 'button',
            text: { type: 'plain_text', text: opt.label, emoji: true },
            action_id: `wf_choice:${ctx.conversationId}:${stepId}:${opt.value}`,
            value: opt.value,
          })),
        },
      ];
      break;
    }

    case 'trigger_csat': {
      const stepId = (result.stepId || '') as string;
      const ratings = [
        { value: '1', emoji: '\u{1F61E}' },
        { value: '2', emoji: '\u{1F641}' },
        { value: '3', emoji: '\u{1F610}' },
        { value: '4', emoji: '\u{1F642}' },
        { value: '5', emoji: '\u{1F60A}' },
      ];

      blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: text || 'How would you rate your experience?' } },
        {
          type: 'actions',
          block_id: `wf_csat_${stepId}`,
          elements: ratings.map((r) => ({
            type: 'button',
            text: { type: 'plain_text', text: `${r.emoji} ${r.value}`, emoji: true },
            action_id: `wf_csat:${ctx.conversationId}:${stepId}:${r.value}`,
            value: r.value,
          })),
        },
      ];
      break;
    }

    case 'collect_input':
    case 'collect_customer_info': {
      const fields = (result.fields || []) as Array<{ label: string; required?: boolean }>;
      const fieldList = fields.map((f) => `${f.required ? '*' : ''}${f.label}${f.required ? '*' : ''}`).join('\n- ');

      blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: text || 'Please provide the following information:' } },
        { type: 'section', text: { type: 'mrkdwn', text: `- ${fieldList}\n\n_Please reply in this thread._` } },
      ];
      break;
    }

    default:
      break;
  }

  const body: Record<string, unknown> = {
    channel: slackChannelId,
    text: text || 'New message from support',
  };

  if (slackThreadTs) body.thread_ts = slackThreadTs;
  if (blocks) body.blocks = blocks;

  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const apiResult = await response.json() as { ok: boolean; error?: string };

  if (!apiResult.ok) {
    console.error(`[ChannelDispatch:Slack] API error: ${apiResult.error}`);
  } else {
    console.log(`[ChannelDispatch:Slack] Step ${ctx.stepType} dispatched to ${slackChannelId}`);
  }
}
