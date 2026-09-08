/**
 * Discord bot ingest webhooks.
 *
 * Called by discord-bot-worker (Interactions + Gateway DO) with X-Bot-Secret.
 * Persists tickets/messages into helpdeskConversations (not desk_*), matching
 * app-api channel-dispatch and the legacy Hetzner discord-bot.
 */

import { Hono } from 'hono';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import type { Env } from '../index';
import { getTenantDbForWorkspace, schema } from '../db';
import { generateId } from '../lib/id';
import { error, success } from '../lib/response';

export const discordWebhookRoutes = new Hono<{ Bindings: Env }>();

interface GuildMapping {
  clerkOrgId: string;
  internalWorkspaceId?: string;
}

type FormField = {
  id: string;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
};

discordWebhookRoutes.use('*', async (c, next) => {
  const secret = c.env.DISCORD_BOT_SECRET;
  if (!secret) {
    return error.internal(c, 'Discord bot secret not configured');
  }
  const provided = c.req.header('X-Bot-Secret');
  if (!provided || provided !== secret) {
    return error.unauthorized(c, 'Invalid bot secret');
  }
  await next();
});

/** Secret fingerprint + optional guild KV check (no secret values returned). */
discordWebhookRoutes.post('/ping', async (c) => {
  const body = await c.req.json<{ guild_id?: string }>().catch(() => ({} as { guild_id?: string }));
  const fingerprint = await sha256HexPrefix(c.env.DISCORD_BOT_SECRET || '');

  let guildMapped: boolean | undefined;
  if (body?.guild_id) {
    const mapping = await resolveGuild(c.env, body.guild_id);
    guildMapped = !!mapping?.clerkOrgId;
    if (!guildMapped) {
      console.warn('[discord-webhook] ping guild miss:', body.guild_id);
    }
  }

  return success(c, {
    secretConfigured: !!c.env.DISCORD_BOT_SECRET,
    fingerprint,
    guildId: body?.guild_id ?? null,
    guildMapped: guildMapped ?? null,
  });
});

discordWebhookRoutes.post('/ticket', async (c) => {
  const body = await c.req.json<{
    guild_id: string;
    thread_id: string;
    parent_channel_id?: string;
    user: { id: string; username: string; avatar?: string | null };
  }>();

  if (!body?.guild_id || !body?.thread_id || !body?.user?.id) {
    return error.badRequest(c, 'guild_id, thread_id, and user.id are required');
  }

  const mapping = await resolveGuild(c.env, body.guild_id);
  if (!mapping) {
    console.warn('[discord-webhook] ticket create guild miss:', body.guild_id, {
      threadId: body.thread_id,
      parentChannelId: body.parent_channel_id ?? null,
    });
    return error.notFound(c, 'Discord guild mapping');
  }

  try {
    const db = await getTenantDbForWorkspace(c.env, mapping.clerkOrgId);
    const now = new Date();
    const conversationId = generateId('conv');
    const conversationNumber = `CONV-${Date.now().toString(36).toUpperCase()}`;
    const customerName = body.user.username;
    const customerEmail = `discord:${body.user.id}@discord`;
    const avatar =
      body.user.avatar != null
        ? `https://cdn.discordapp.com/avatars/${body.user.id}/${body.user.avatar}.png`
        : undefined;

    await db.insert(schema.helpdeskConversations).values({
      id: conversationId,
      conversationNumber,
      subject: 'Discord Ticket',
      status: 'active',
      channel: 'discord',
      customerEmail,
      customerName,
      customerAvatar: avatar,
      contactId: null,
      messageCount: 0,
      unreadCount: 0,
      isRead: false,
      isStarred: false,
      isArchived: false,
      hasAttachments: false,
      hasActiveWorkflow: false,
      isTicket: true,
      tags: [],
      metadata: {
        discordGuildId: body.guild_id,
        discordChannelId: body.thread_id,
        discordUserId: body.user.id,
        discordAvatar: avatar,
        isTicket: true,
        // Panel channel that hosted Open Ticket — used for supportChannels monitoring
        ...(body.parent_channel_id ? { parentChannelId: body.parent_channel_id } : {}),
      },
      createdAt: now,
      updatedAt: now,
    });

    await publishHelpdesk(c.env, mapping.clerkOrgId, 'conversation_new', {
      conversationId,
      subject: 'Discord Ticket',
      customerName,
      customerEmail,
      preview: `Ticket opened by ${customerName}`,
      channel: 'discord',
      createdAt: now.toISOString(),
    });

    await triggerWorkflow(c.env, {
      type: 'conversation_created',
      conversationId,
      workspaceId: mapping.clerkOrgId,
      data: {
        conversationId,
        workspaceId: mapping.clerkOrgId,
        channel: 'discord',
        customerName,
        customerEmail,
        subject: 'Discord Ticket',
        timestamp: now.toISOString(),
      },
    });

    return success(c, { conversationId }, 201);
  } catch (err) {
    console.error('[discord-webhook] ticket create failed:', err);
    return error.internal(c, 'Failed to create Discord ticket');
  }
});

discordWebhookRoutes.post('/ticket-close', async (c) => {
  const body = await c.req.json<{ guild_id: string; thread_id: string }>();

  if (!body?.guild_id || !body?.thread_id) {
    return error.badRequest(c, 'guild_id and thread_id are required');
  }

  const mapping = await resolveGuild(c.env, body.guild_id);
  if (!mapping) {
    return error.notFound(c, 'Discord guild mapping');
  }

  try {
    const db = await getTenantDbForWorkspace(c.env, mapping.clerkOrgId);
    const [conv] = await db
      .select({ id: schema.helpdeskConversations.id })
      .from(schema.helpdeskConversations)
      .where(
        and(
          eq(schema.helpdeskConversations.channel, 'discord'),
          sql`${schema.helpdeskConversations.metadata}->>'discordChannelId' = ${body.thread_id}`,
          ne(schema.helpdeskConversations.status, 'closed'),
          isNull(schema.helpdeskConversations.deletedAt),
        ),
      )
      .limit(1);

    if (!conv) {
      return success(c, { closed: false, reason: 'not_found' });
    }

    const now = new Date();
    await db
      .update(schema.helpdeskConversations)
      .set({ status: 'closed', closedAt: now, updatedAt: now })
      .where(eq(schema.helpdeskConversations.id, conv.id));

    await publishHelpdesk(c.env, mapping.clerkOrgId, 'conversation_updated', {
      conversationId: conv.id,
      status: 'closed',
    });

    return success(c, { closed: true, conversationId: conv.id });
  } catch (err) {
    console.error('[discord-webhook] ticket close failed:', err);
    return error.internal(c, 'Failed to close Discord ticket');
  }
});

discordWebhookRoutes.post('/message', async (c) => {
  const body = await c.req.json<{
    id: string;
    channel_id: string;
    guild_id: string;
    author: {
      id: string;
      username: string;
      discriminator?: string;
      bot?: boolean;
      avatar?: string | null;
    };
    content: string;
    timestamp?: string;
  }>();

  if (!body?.guild_id || !body?.channel_id || !body?.author?.id) {
    return error.badRequest(c, 'guild_id, channel_id, and author.id are required');
  }
  if (body.author.bot) {
    return success(c, { ignored: true, reason: 'bot' });
  }
  if (!body.content?.trim()) {
    return success(c, { ignored: true, reason: 'empty' });
  }

  const mapping = await resolveGuild(c.env, body.guild_id);
  if (!mapping) {
    return success(c, { ignored: true, reason: 'unknown_guild' });
  }

  try {
    const db = await getTenantDbForWorkspace(c.env, mapping.clerkOrgId);

    const rows = await db
      .select({
        status: schema.helpdeskChannelIntegrations.status,
        config: schema.helpdeskChannelIntegrations.config,
        accountInfo: schema.helpdeskChannelIntegrations.accountInfo,
      })
      .from(schema.helpdeskChannelIntegrations)
      .where(
        and(
          eq(schema.helpdeskChannelIntegrations.provider, 'discord'),
          isNull(schema.helpdeskChannelIntegrations.deletedAt),
        ),
      );

    const integration =
      rows.find((row) => {
        const info = row.accountInfo as { id?: string; metadata?: { guildId?: string } } | null;
        return info?.metadata?.guildId === body.guild_id || info?.id === body.guild_id;
      }) ?? rows[0];

    if (!integration || integration.status !== 'connected') {
      return success(c, { ignored: true, reason: 'not_connected' });
    }

    const config = (integration.config || {}) as Record<string, unknown>;
    const supportChannels = (config.supportChannels || []) as Array<{
      channelId: string;
      enabled: boolean;
    }>;
    const enabledChannels = supportChannels.filter((ch) => ch.enabled);

    // Opt-in monitoring: nothing selected → do not ingest messages
    if (enabledChannels.length === 0) {
      return success(c, { ignored: true, reason: 'not_monitored' });
    }

    const [existingConv] = await db
      .select()
      .from(schema.helpdeskConversations)
      .where(
        and(
          eq(schema.helpdeskConversations.channel, 'discord'),
          sql`${schema.helpdeskConversations.metadata}->>'discordChannelId' = ${body.channel_id}`,
          ne(schema.helpdeskConversations.status, 'closed'),
          isNull(schema.helpdeskConversations.deletedAt),
        ),
      )
      .limit(1);

    if (!existingConv) {
      return success(c, { ignored: true, reason: 'unknown_thread' });
    }

    // Prefer parentChannelId stored at ticket create (Gateway MESSAGE_CREATE has no parent_id)
    const meta = (existingConv.metadata || {}) as { parentChannelId?: string };
    if (meta.parentChannelId) {
      const allowed = enabledChannels.some((ch) => ch.channelId === meta.parentChannelId);
      if (!allowed) {
        return success(c, { ignored: true, reason: 'channel_not_monitored' });
      }
    }

    let customerEmail = `discord:${body.author.id}@discord`;
    let customerName = body.author.username;

    try {
      const [identity] = await db
        .select({
          personId: schema.contactExternalIdentities.personId,
          externalEmail: schema.contactExternalIdentities.externalEmail,
        })
        .from(schema.contactExternalIdentities)
        .where(
          and(
            eq(schema.contactExternalIdentities.provider, 'discord'),
            eq(schema.contactExternalIdentities.externalId, body.author.id),
          ),
        )
        .limit(1);

      if (identity) {
        if (identity.externalEmail) customerEmail = identity.externalEmail;
        if (identity.personId) {
          const [person] = await db
            .select({
              fullName: schema.people.fullName,
              displayName: schema.people.displayName,
            })
            .from(schema.people)
            .where(eq(schema.people.id, identity.personId))
            .limit(1);
          if (person?.fullName) customerName = person.fullName;
          else if (person?.displayName) customerName = person.displayName;
        }
      }
    } catch {
      // Non-fatal
    }

    const now = body.timestamp ? new Date(body.timestamp) : new Date();
    const msgId = generateId('msg');
    const messageContent = body.content;

    await db.insert(schema.helpdeskConversationMessages).values({
      id: msgId,
      conversationId: existingConv.id,
      authorId: `discord_${body.author.id}`,
      authorName: customerName,
      authorType: 'customer',
      content: messageContent,
      type: 'message',
      isPublic: true,
      isInternal: false,
      status: 'sent',
      isRead: false,
      metadata: {
        discordMessageId: body.id,
        discordChannelId: body.channel_id,
        channel: 'discord',
      },
      createdAt: now,
      updatedAt: now,
    });

    await db
      .update(schema.helpdeskConversations)
      .set({
        lastMessage: messageContent.substring(0, 500),
        preview: messageContent.substring(0, 200),
        lastMessageAt: now,
        lastCustomerMessageAt: now,
        messageCount: sql`${schema.helpdeskConversations.messageCount} + 1`,
        unreadCount: sql`${schema.helpdeskConversations.unreadCount} + 1`,
        isRead: false,
        updatedAt: now,
      })
      .where(eq(schema.helpdeskConversations.id, existingConv.id));

    if (c.env.REALTIME) {
      try {
        const rt = new RealtimePublisher(c.env.REALTIME);
        await rt.conversationPublish(existingConv.id, {
          type: 'message',
          id: msgId,
          content: messageContent,
          senderId: `discord_${body.author.id}`,
          senderName: customerName,
          senderType: 'customer',
          ts: Date.now(),
        });
        await rt.helpdeskEvent(mapping.clerkOrgId, 'conversation_updated', {
          conversationId: existingConv.id,
        });
      } catch (err) {
        console.error('[discord-webhook] realtime publish failed:', err);
      }
    }

    await triggerWorkflow(c.env, {
      type: 'message_received',
      conversationId: existingConv.id,
      workspaceId: mapping.clerkOrgId,
      data: {
        conversationId: existingConv.id,
        workspaceId: mapping.clerkOrgId,
        channel: 'discord',
        customerName,
        customerEmail,
        content: messageContent,
        messageId: msgId,
        authorType: 'customer',
        authorName: customerName,
        timestamp: now.toISOString(),
      },
    });

    return success(c, { conversationId: existingConv.id, messageId: msgId });
  } catch (err) {
    console.error('[discord-webhook] message ingest failed:', err);
    return error.internal(c, 'Failed to ingest Discord message');
  }
});

discordWebhookRoutes.post('/form-fields', async (c) => {
  const body = await c.req.json<{
    guild_id: string;
    conversation_id: string;
    step_id: string;
  }>();

  if (!body?.guild_id || !body?.conversation_id || !body?.step_id) {
    return error.badRequest(c, 'guild_id, conversation_id, and step_id are required');
  }

  const mapping = await resolveGuild(c.env, body.guild_id);
  if (!mapping) {
    return error.notFound(c, 'Discord guild mapping');
  }

  try {
    const db = await getTenantDbForWorkspace(c.env, mapping.clerkOrgId);
    const fields = await loadFormFields(db, body.conversation_id, body.step_id);

    const [execution] = await db
      .select({ id: schema.helpdeskWorkflowExecutions.id })
      .from(schema.helpdeskWorkflowExecutions)
      .where(
        and(
          eq(schema.helpdeskWorkflowExecutions.conversationId, body.conversation_id),
          eq(schema.helpdeskWorkflowExecutions.status, 'waiting_for_input'),
        ),
      )
      .limit(1);

    return success(c, {
      workspaceId: mapping.clerkOrgId,
      executionId: execution?.id ?? null,
      fields,
    });
  } catch (err) {
    console.error('[discord-webhook] form-fields failed:', err);
    return error.internal(c, 'Failed to load form fields');
  }
});

discordWebhookRoutes.post('/resolve-guild', async (c) => {
  const body = await c.req.json<{ guild_id: string }>();
  if (!body?.guild_id) {
    return error.badRequest(c, 'guild_id is required');
  }
  const mapping = await resolveGuild(c.env, body.guild_id);
  if (!mapping) {
    return error.notFound(c, 'Discord guild mapping');
  }
  return success(c, {
    workspaceId: mapping.clerkOrgId,
    internalWorkspaceId: mapping.internalWorkspaceId ?? null,
  });
});

discordWebhookRoutes.post('/workflow-respond', async (c) => {
  const body = await c.req.json<{
    guild_id: string;
    conversation_id: string;
    step_id: string;
    selectedValue?: string;
    selectedLabel?: string;
    submittedData?: Record<string, string>;
    rating?: number;
    feedback?: string;
  }>();

  if (!body?.guild_id || !body?.conversation_id || !body?.step_id) {
    return error.badRequest(c, 'guild_id, conversation_id, and step_id are required');
  }

  const mapping = await resolveGuild(c.env, body.guild_id);
  if (!mapping) {
    return error.notFound(c, 'Discord guild mapping');
  }

  if (!c.env.WORKFLOW_WORKER) {
    return error.internal(c, 'Workflow worker not configured');
  }

  try {
    const db = await getTenantDbForWorkspace(c.env, mapping.clerkOrgId);
    const [execution] = await db
      .select({ id: schema.helpdeskWorkflowExecutions.id })
      .from(schema.helpdeskWorkflowExecutions)
      .where(
        and(
          eq(schema.helpdeskWorkflowExecutions.conversationId, body.conversation_id),
          eq(schema.helpdeskWorkflowExecutions.status, 'waiting_for_input'),
        ),
      )
      .limit(1);

    if (!execution) {
      return error.notFound(c, 'Waiting workflow execution');
    }

    if (body.submittedData && Object.keys(body.submittedData).length > 0) {
      const summary = Object.entries(body.submittedData)
        .map(([key, value]) => `**${key}**: ${value}`)
        .join('\n');
      const now = new Date();
      await db.insert(schema.helpdeskConversationMessages).values({
        id: generateId('msg'),
        conversationId: body.conversation_id,
        content: summary,
        authorType: 'customer',
        authorId: 'discord_form',
        authorName: 'Form submission',
        type: 'message',
        isPublic: true,
        isInternal: false,
        status: 'sent',
        isRead: false,
        metadata: {
          formSubmission: true,
          submittedData: body.submittedData,
          workflowStepId: body.step_id,
          channel: 'discord',
        },
        createdAt: now,
        updatedAt: now,
      });
    }

    const res = await c.env.WORKFLOW_WORKER.fetch(
      new Request('https://workflow-worker/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: body.conversation_id,
          workspaceId: mapping.clerkOrgId,
          executionId: execution.id,
          stepId: body.step_id,
          selectedValue: body.selectedValue,
          selectedLabel: body.selectedLabel,
          submittedData: body.submittedData,
          rating: body.rating,
          feedback: body.feedback,
        }),
      }),
    );

    const result = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[discord-webhook] workflow respond failed:', res.status, result);
      return error.internal(c, 'Failed to resume workflow');
    }

    return success(c, { workspaceId: mapping.clerkOrgId, executionId: execution.id, result });
  } catch (err) {
    console.error('[discord-webhook] workflow-respond failed:', err);
    return error.internal(c, 'Failed to resume workflow');
  }
});

async function resolveGuild(env: Env, guildId: string): Promise<GuildMapping | null> {
  const cached = (await env.WORKSPACE_CACHE.get(`discord_guild:${guildId}`, 'json')) as GuildMapping | null;
  if (cached?.clerkOrgId) return cached;
  console.warn('[discord-webhook] missing discord_guild KV mapping for guild', guildId);
  return null;
}

/** First 16 hex chars of SHA-256 — compare equality without exposing the secret. */
async function sha256HexPrefix(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < 8; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

async function publishHelpdesk(
  env: Env,
  workspaceId: string,
  event: string,
  data: Record<string, unknown>,
) {
  if (!env.REALTIME) return;
  try {
    const rt = new RealtimePublisher(env.REALTIME);
    await rt.helpdeskEvent(workspaceId, event, data);
  } catch (err) {
    console.error('[discord-webhook] helpdesk realtime failed:', err);
  }
}

async function triggerWorkflow(
  env: Env,
  body: {
    type: 'conversation_created' | 'message_received';
    conversationId: string;
    workspaceId: string;
    data: Record<string, unknown>;
  },
) {
  if (!env.WORKFLOW_WORKER) return;
  try {
    await env.WORKFLOW_WORKER.fetch(
      new Request('https://workflow-worker/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  } catch (err) {
    console.error('[discord-webhook] workflow event failed:', err);
  }
}

async function loadFormFields(
  db: Awaited<ReturnType<typeof getTenantDbForWorkspace>>,
  conversationId: string,
  stepId: string,
): Promise<FormField[]> {
  const [execution] = await db
    .select({
      executionContext: schema.helpdeskWorkflowExecutions.executionContext,
    })
    .from(schema.helpdeskWorkflowExecutions)
    .where(
      and(
        eq(schema.helpdeskWorkflowExecutions.conversationId, conversationId),
        eq(schema.helpdeskWorkflowExecutions.status, 'waiting_for_input'),
      ),
    )
    .limit(1);

  const execCtx = (execution?.executionContext || {}) as Record<string, unknown>;
  const stepResults = (execCtx.stepResults || {}) as Record<string, Record<string, unknown>>;
  const stepResult = stepResults[stepId] || {};
  const rawFields = (stepResult.fields || []) as Array<string | FormField>;

  const fields: FormField[] = rawFields.map((field) => {
    if (typeof field === 'string') {
      return {
        id: field,
        label: field.charAt(0).toUpperCase() + field.slice(1),
        required: true,
      };
    }
    return {
      id: field.id || field.label || 'field',
      label: field.label || field.id || 'Field',
      type: field.type,
      required: field.required ?? false,
      placeholder: field.placeholder,
    };
  });

  if (fields.length > 0) return fields;

  const [msg] = await db
    .select({ metadata: schema.helpdeskConversationMessages.metadata })
    .from(schema.helpdeskConversationMessages)
    .where(
      and(
        eq(schema.helpdeskConversationMessages.conversationId, conversationId),
        sql`${schema.helpdeskConversationMessages.metadata}->>'workflowStepId' = ${stepId}`,
      ),
    )
    .limit(1);

  const msgFields = ((msg?.metadata as { fields?: Array<string | FormField> } | null)?.fields ||
    []) as Array<string | FormField>;

  return msgFields.map((field) => {
    if (typeof field === 'string') {
      return {
        id: field,
        label: field.charAt(0).toUpperCase() + field.slice(1),
        required: true,
      };
    }
    return {
      id: field.id || field.label || 'field',
      label: field.label || field.id || 'Field',
      type: field.type,
      required: field.required ?? false,
      placeholder: field.placeholder,
    };
  });
}
