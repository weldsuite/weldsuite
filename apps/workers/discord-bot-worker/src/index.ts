/**
 * Discord Bot Worker — Interactions HTTP + Gateway Durable Object control plane.
 *
 * - POST /interactions — Discord Interactions Endpoint (buttons, slash, modals)
 * - POST /manage/connect|disconnect — start/stop Gateway DO
 * - GET  /manage/status|/health
 *
 * Ticket create/close and message ingest go to helpdesk-widget-api webhooks.
 * Workflow resumes go through widget-api /webhook/discord/workflow-respond.
 */

import { Hono } from 'hono';
import {
  createPrivateThread,
  addThreadMember,
  sendMessageWithEmbed,
  sendMessage,
  archiveThread,
  followUpInteraction,
} from './lib/discord-api';

export { DiscordGateway } from './gateway';

interface Env {
  DISCORD_BOT_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
  HELPDESK_WIDGET_API_URL: string;
  MANAGEMENT_SECRET: string;
  ENVIRONMENT: string;
  DISCORD_GATEWAY: DurableObjectNamespace;
  WORKFLOW_WORKER?: Fetcher;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/robots.txt', (c) => {
  return c.text('User-agent: *\nDisallow: /\n');
});

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'discord-bot-worker',
    environment: c.env.ENVIRONMENT,
  });
});

// ============================================================================
// Discord Interactions endpoint — Ed25519 signature verification
// ============================================================================

app.post('/interactions', async (c) => {
  const publicKey = c.env.DISCORD_PUBLIC_KEY;
  if (!publicKey) {
    return c.json({ error: 'Discord public key not configured' }, 500);
  }

  const signature = c.req.header('X-Signature-Ed25519');
  const timestamp = c.req.header('X-Signature-Timestamp');

  if (!signature || !timestamp) {
    return c.json({ error: 'Missing signature headers' }, 401);
  }

  const body = await c.req.text();

  try {
    const isValid = await verifyDiscordSignature(body, signature, timestamp, publicKey);
    if (!isValid) {
      return c.json({ error: 'Invalid signature' }, 401);
    }
  } catch {
    return c.json({ error: 'Signature verification failed' }, 401);
  }

  const interaction = JSON.parse(body);

  // PING
  if (interaction.type === 1) {
    return c.json({ type: 1 });
  }

  // APPLICATION_COMMAND (slash)
  if (interaction.type === 2) {
    const commandName = interaction.data?.name as string | undefined;
    if (commandName === 'setup-support') {
      const promise = handleSetupSupport(c.env, interaction);
      try {
        c.executionCtx.waitUntil(promise);
      } catch {
        /* still runs */
      }
      return c.json({ type: 5, data: { flags: 64 } });
    }
    return c.json({ type: 4, data: { content: 'Unknown command.', flags: 64 } });
  }

  // MESSAGE_COMPONENT (buttons)
  if (interaction.type === 3) {
    const customId = interaction.data?.custom_id as string | undefined;

    if (customId === 'open_ticket') {
      const promise = handleOpenTicket(c.env, interaction);
      try {
        c.executionCtx.waitUntil(promise);
      } catch {
        /* still runs */
      }
      return c.json({ type: 5, data: { flags: 64 } });
    }

    if (customId === 'close_ticket') {
      const promise = handleCloseTicket(c.env, interaction);
      try {
        c.executionCtx.waitUntil(promise);
      } catch {
        /* still runs */
      }
      return c.json({ type: 5, data: { flags: 64 } });
    }

    if (customId?.startsWith('wf_form:')) {
      // Must respond synchronously with a modal (type 9)
      return handleFormButton(c.env, interaction);
    }

    if (customId?.startsWith('wf_')) {
      const promise = handleWorkflowButton(c.env, interaction, customId);
      try {
        c.executionCtx.waitUntil(promise);
      } catch {
        /* still runs */
      }
      // type 6 = DEFERRED_UPDATE_MESSAGE
      return c.json({ type: 6 });
    }

    return c.json({ type: 6 });
  }

  // MODAL_SUBMIT
  if (interaction.type === 5) {
    const customId = interaction.data?.custom_id as string | undefined;
    if (customId?.startsWith('wf_form_submit:')) {
      const promise = handleFormSubmit(c.env, interaction, customId);
      try {
        c.executionCtx.waitUntil(promise);
      } catch {
        /* still runs */
      }
      return c.json({ type: 6 });
    }
    return c.json({ type: 6 });
  }

  return c.json({ type: 4, data: { content: '', flags: 64 } });
});

// ============================================================================
// Management endpoints — protected by MANAGEMENT_SECRET
// ============================================================================

app.use('/manage/*', async (c, next) => {
  const auth = c.req.header('Authorization');
  const expected = `Bearer ${c.env.MANAGEMENT_SECRET}`;

  if (!auth || auth !== expected) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
});

app.post('/manage/connect', async (c) => {
  const stub = getGatewayStub(c.env);
  const res = await stub.fetch(new Request('https://do/connect', { method: 'POST' }));
  const data = await res.json();
  return c.json(data, res.status as 200);
});

app.post('/manage/disconnect', async (c) => {
  const stub = getGatewayStub(c.env);
  const res = await stub.fetch(new Request('https://do/disconnect', { method: 'POST' }));
  const data = await res.json();
  return c.json(data, res.status as 200);
});

app.get('/manage/status', async (c) => {
  const stub = getGatewayStub(c.env);
  const res = await stub.fetch(new Request('https://do/status'));
  const data = await res.json();
  return c.json(data);
});

/**
 * Diagnose WeldDesk sync without printing secret values.
 * Compares local DISCORD_PUBLIC_KEY fingerprint to widget-api DISCORD_BOT_SECRET
 * by probing /webhook/discord/ping, and optionally checks guild KV mapping.
 */
app.get('/manage/debug-sync', async (c) => {
  const guildId = c.req.query('guild_id') || undefined;
  const localFingerprint = await sha256HexPrefix(c.env.DISCORD_PUBLIC_KEY);

  let widgetPing: {
    ok: boolean;
    status: number;
    secretConfigured?: boolean;
    fingerprint?: string | null;
    error?: string;
  };

  try {
    const res = await fetch(`${c.env.HELPDESK_WIDGET_API_URL}/webhook/discord/ping`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bot-Secret': c.env.DISCORD_PUBLIC_KEY,
      },
      body: JSON.stringify(guildId ? { guild_id: guildId } : {}),
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: {
        secretConfigured?: boolean;
        fingerprint?: string;
        guildMapped?: boolean;
        guildId?: string | null;
      };
      error?: string;
    };
    widgetPing = {
      ok: res.ok,
      status: res.status,
      secretConfigured: body.data?.secretConfigured,
      fingerprint: body.data?.fingerprint ?? null,
      error: body.error,
    };

    return c.json({
      localSecretFingerprint: localFingerprint,
      secretMatch: res.ok && body.data?.fingerprint === localFingerprint,
      widgetPing,
      guild: guildId
        ? {
            guildId,
            mapped: body.data?.guildMapped === true,
            hint:
              body.data?.guildMapped === true
                ? null
                : 'Missing discord_guild KV — reconnect Discord in WeldDesk settings',
          }
        : null,
      hints: {
        secretMismatch:
          'Set helpdesk-widget-api DISCORD_BOT_SECRET to the same value as discord-bot-worker DISCORD_PUBLIC_KEY',
        guildMiss: 'Reconnect Discord OAuth in WeldDesk so discord_guild:{id} is written to shared KV',
      },
    });
  } catch (err) {
    return c.json(
      {
        localSecretFingerprint: localFingerprint,
        secretMatch: false,
        widgetPing: {
          ok: false,
          status: 0,
          error: err instanceof Error ? err.message : String(err),
        },
      },
      502,
    );
  }
});

/** Register global slash commands (idempotent). Call once after deploy. */
app.post('/manage/register-commands', async (c) => {
  const appId = c.env.DISCORD_APPLICATION_ID;
  const res = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${c.env.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([
      {
        name: 'setup-support',
        description: 'Post a support panel with an "Open Ticket" button in this channel',
        default_member_permissions: '16', // Manage Channels
        type: 1,
      },
    ]),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return c.json({ error: 'Failed to register commands', details: data }, 502);
  }
  return c.json({ registered: true, commands: data });
});

// ============================================================================
// Slash: /setup-support
// ============================================================================

async function handleSetupSupport(env: Env, interaction: any): Promise<void> {
  const token = interaction.token;
  const channelId = interaction.channel_id;

  try {
    await sendMessageWithEmbed(env.DISCORD_BOT_TOKEN, channelId, {
      embed: {
        title: 'Support',
        description:
          'Need help? Click the button below to open a private support ticket.\n\n' +
          'A team member will get back to you as soon as possible.',
        color: 0x5865f2,
      },
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 1,
              label: 'Open Ticket',
              custom_id: 'open_ticket',
              emoji: { name: '🎫' },
            },
          ],
        },
      ],
    });

    await followUpInteraction(
      env.DISCORD_APPLICATION_ID,
      token,
      'Support panel posted! Users can now click "Open Ticket" to create private threads.',
    );
  } catch (err) {
    console.error('[Interactions] Failed to setup-support:', err);
    try {
      await followUpInteraction(
        env.DISCORD_APPLICATION_ID,
        token,
        'Failed to post the support panel. Make sure the bot can send messages here.',
      );
    } catch {
      // best effort
    }
  }
}

// ============================================================================
// Ticket Interaction Handlers
// ============================================================================

async function handleOpenTicket(env: Env, interaction: any): Promise<void> {
  const user = interaction.member?.user || interaction.user;
  const guildId = interaction.guild_id;
  const channelId = interaction.channel_id;
  const token = interaction.token;

  try {
    const threadName = `Ticket - ${user.username}`;
    const thread = await createPrivateThread(env.DISCORD_BOT_TOKEN, channelId, threadName);

    await addThreadMember(env.DISCORD_BOT_TOKEN, thread.id, user.id);

    await sendMessageWithEmbed(env.DISCORD_BOT_TOKEN, thread.id, {
      embed: {
        title: 'Support Ticket',
        description: `Welcome <@${user.id}>! A support agent will be with you shortly.\n\nPlease describe your issue below.`,
        color: 0x5865f2,
        timestamp: new Date().toISOString(),
      },
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 4,
              label: 'Close Ticket',
              custom_id: 'close_ticket',
            },
          ],
        },
      ],
    });

    const ticketRes = await fetch(`${env.HELPDESK_WIDGET_API_URL}/webhook/discord/ticket`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bot-Secret': env.DISCORD_PUBLIC_KEY,
      },
      body: JSON.stringify({
        guild_id: guildId,
        thread_id: thread.id,
        // Panel channel — stored as metadata.parentChannelId for supportChannels filtering
        parent_channel_id: channelId,
        user: {
          id: user.id,
          username: user.username,
          avatar: user.avatar,
        },
      }),
    });

    if (!ticketRes.ok) {
      const text = await ticketRes.text().catch(() => '');
      console.error('[Interactions] ticket webhook failed:', ticketRes.status, text.slice(0, 500), {
        guildId,
        threadId: thread.id,
        parentChannelId: channelId,
      });

      let syncHint =
        'Your Discord thread was created, but WeldDesk sync failed. Please notify an admin.';
      if (ticketRes.status === 401) {
        syncHint =
          'Your Discord thread was created, but WeldDesk sync failed (bot secret mismatch). An admin must sync DISCORD_BOT_SECRET with the bot public key.';
      } else if (ticketRes.status === 404) {
        syncHint =
          'Your Discord thread was created, but WeldDesk sync failed (Discord server not linked). An admin should reconnect Discord in WeldDesk settings.';
      }

      await followUpInteraction(
        env.DISCORD_APPLICATION_ID,
        token,
        `Thread created: <#${thread.id}>\n\n⚠️ ${syncHint}`,
      );
      return;
    }

    console.log('[Interactions] ticket webhook ok:', {
      guildId,
      threadId: thread.id,
      parentChannelId: channelId,
      status: ticketRes.status,
    });

    await followUpInteraction(
      env.DISCORD_APPLICATION_ID,
      token,
      `Your ticket has been created! Head to <#${thread.id}>`,
    );
  } catch (err) {
    console.error('[Interactions] Failed to handle open_ticket:', err);
    try {
      await followUpInteraction(
        env.DISCORD_APPLICATION_ID,
        token,
        'Something went wrong creating your ticket. Please try again.',
      );
    } catch {
      // best effort
    }
  }
}

async function handleCloseTicket(env: Env, interaction: any): Promise<void> {
  const threadId = interaction.channel_id;
  const guildId = interaction.guild_id;
  const token = interaction.token;

  try {
    await fetch(`${env.HELPDESK_WIDGET_API_URL}/webhook/discord/ticket-close`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bot-Secret': env.DISCORD_PUBLIC_KEY,
      },
      body: JSON.stringify({
        guild_id: guildId,
        thread_id: threadId,
      }),
    });

    await sendMessage(
      env.DISCORD_BOT_TOKEN,
      threadId,
      'This ticket has been closed. If you need further help, please open a new ticket.',
    );

    await archiveThread(env.DISCORD_BOT_TOKEN, threadId);

    await followUpInteraction(env.DISCORD_APPLICATION_ID, token, 'This ticket has been closed.');
  } catch (err) {
    console.error('[Interactions] Failed to handle close_ticket:', err);
    try {
      await followUpInteraction(
        env.DISCORD_APPLICATION_ID,
        token,
        'Something went wrong closing the ticket. Please try again.',
      );
    } catch {
      // best effort
    }
  }
}

// ============================================================================
// Workflow buttons + modals
// ============================================================================

async function handleWorkflowButton(env: Env, interaction: any, customId: string): Promise<void> {
  const guildId = interaction.guild_id as string | undefined;
  if (!guildId) return;

  // wf_choice:convId:stepId:value | wf_csat:convId:stepId:rating
  const parts = customId.split(':');
  if (parts.length < 4) return;

  const [action, conversationId, stepId, value] = parts;
  const payload: Record<string, unknown> = {
    guild_id: guildId,
    conversation_id: conversationId,
    step_id: stepId,
  };

  if (action === 'wf_choice') {
    payload.selectedValue = value;
    const label =
      interaction.message?.components?.[0]?.components?.find(
        (comp: { custom_id?: string; label?: string }) => comp.custom_id === customId,
      )?.label || value;
    payload.selectedLabel = label;
  } else if (action === 'wf_csat') {
    payload.rating = parseInt(value, 10);
  } else {
    return;
  }

  try {
    const res = await fetch(`${env.HELPDESK_WIDGET_API_URL}/webhook/discord/workflow-respond`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bot-Secret': env.DISCORD_PUBLIC_KEY,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error('[Interactions] workflow-respond failed:', res.status, await res.text());
    }
  } catch (err) {
    console.error('[Interactions] Failed to forward wf_ button:', err);
  }
}

async function handleFormButton(env: Env, interaction: any): Promise<Response> {
  const customId = interaction.data?.custom_id as string;
  const guildId = interaction.guild_id as string | undefined;
  const parts = customId.split(':');
  if (!guildId || parts.length < 3) {
    return Response.json({
      type: 4,
      data: { content: 'Unable to open this form.', flags: 64 },
    });
  }

  const [, conversationId, stepId] = parts;

  try {
    const res = await fetch(`${env.HELPDESK_WIDGET_API_URL}/webhook/discord/form-fields`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bot-Secret': env.DISCORD_PUBLIC_KEY,
      },
      body: JSON.stringify({
        guild_id: guildId,
        conversation_id: conversationId,
        step_id: stepId,
      }),
    });

    const json = (await res.json().catch(() => null)) as {
      success?: boolean;
      data?: { fields?: Array<{ id: string; label: string; type?: string; required?: boolean; placeholder?: string }> };
    } | null;

    const fields = json?.data?.fields || [];
    const inputFields =
      fields.length > 0
        ? fields.slice(0, 5)
        : [{ id: 'response', label: 'Your response', type: 'textarea', required: true }];

    const components = inputFields.map((field) => {
      const isLong = field.type === 'textarea';
      return {
        type: 1,
        components: [
          {
            type: 4, // TEXT_INPUT
            custom_id: field.id.slice(0, 100),
            label: field.label.slice(0, 45),
            style: isLong ? 2 : 1, // PARAGRAPH : SHORT
            required: field.required ?? false,
            placeholder: field.placeholder?.slice(0, 100) || undefined,
          },
        ],
      };
    });

    return Response.json({
      type: 9, // MODAL
      data: {
        custom_id: `wf_form_submit:${conversationId}:${stepId}`,
        title: 'Please fill in your details'.slice(0, 45),
        components,
      },
    });
  } catch (err) {
    console.error('[Interactions] Failed to show form modal:', err);
    return Response.json({
      type: 4,
      data: { content: 'Something went wrong opening the form.', flags: 64 },
    });
  }
}

async function handleFormSubmit(env: Env, interaction: any, customId: string): Promise<void> {
  const guildId = interaction.guild_id as string | undefined;
  const channelId = interaction.channel_id as string | undefined;
  const parts = customId.split(':');
  if (!guildId || parts.length < 3) return;

  const [, conversationId, stepId] = parts;
  const submittedData: Record<string, string> = {};

  const rows = (interaction.data?.components || []) as Array<{
    components?: Array<{ custom_id?: string; value?: string }>;
  }>;
  for (const row of rows) {
    for (const component of row.components || []) {
      if (component.custom_id && component.value != null) {
        submittedData[component.custom_id] = component.value;
      }
    }
  }

  try {
    const res = await fetch(`${env.HELPDESK_WIDGET_API_URL}/webhook/discord/workflow-respond`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bot-Secret': env.DISCORD_PUBLIC_KEY,
      },
      body: JSON.stringify({
        guild_id: guildId,
        conversation_id: conversationId,
        step_id: stepId,
        submittedData,
      }),
    });

    if (!res.ok) {
      console.error('[Interactions] form submit workflow-respond failed:', res.status, await res.text());
    }

    if (channelId) {
      const summary = Object.entries(submittedData)
        .map(([key, value]) => `**${key}**: ${value}`)
        .join('\n');
      await sendMessageWithEmbed(env.DISCORD_BOT_TOKEN, channelId, {
        embed: {
          description: summary || 'Details submitted',
          footer: { text: 'Details submitted' },
          color: 0x22c55e,
        },
      });
    }
  } catch (err) {
    console.error('[Interactions] Failed to process form submission:', err);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function getGatewayStub(env: Env): DurableObjectStub {
  const id = env.DISCORD_GATEWAY.idFromName('singleton');
  return env.DISCORD_GATEWAY.get(id);
}

async function verifyDiscordSignature(
  body: string,
  signature: string,
  timestamp: string,
  publicKey: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const message = encoder.encode(timestamp + body);

  const keyBytes = hexToUint8Array(publicKey);
  const sigBytes = hexToUint8Array(signature);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'Ed25519', namedCurve: 'Ed25519' },
    false,
    ['verify'],
  );

  return crypto.subtle.verify('Ed25519', cryptoKey, sigBytes, message);
}

function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/** First 16 hex chars of SHA-256 — enough to compare equality, not enough to recover the secret. */
async function sha256HexPrefix(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < 8; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

export default app;
