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
  // Service binding to centralized workflow worker (for wf_* button interactions)
  WORKFLOW_WORKER?: Fetcher;
}

const app = new Hono<{ Bindings: Env }>();

// ============================================================================
// Health check — no auth
// ============================================================================

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

  // Respond to PING (type 1) with PONG
  if (interaction.type === 1) {
    return c.json({ type: 1 });
  }

  // Handle MESSAGE_COMPONENT interactions (type 3) — button clicks
  if (interaction.type === 3) {
    const customId = interaction.data?.custom_id as string | undefined;

    if (customId === 'open_ticket') {
      // Defer with ephemeral response first, then handle async
      const promise = handleOpenTicket(c.env, interaction);
      try { c.executionCtx.waitUntil(promise); } catch { /* noop — still runs */ }
      // type 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, flags 64 = ephemeral
      return c.json({ type: 5, data: { flags: 64 } });
    }

    if (customId === 'close_ticket') {
      const promise = handleCloseTicket(c.env, interaction);
      try { c.executionCtx.waitUntil(promise); } catch { /* noop */ }
      return c.json({ type: 5, data: { flags: 64 } });
    }

    // Workflow interactions: wf_choice:convId:stepId:value, wf_csat:convId:stepId:rating
    if (customId?.startsWith('wf_') && c.env.WORKFLOW_WORKER) {
      const promise = (async () => {
        try {
          await c.env.WORKFLOW_WORKER!.fetch(
            new Request('https://workflow-worker/discord/interaction', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ data: { custom_id: customId } }),
            }),
          );
        } catch (err) {
          console.error('[Discord] Failed to forward wf_ interaction:', err);
        }
      })();
      try { c.executionCtx.waitUntil(promise); } catch {}
      // Acknowledge immediately — workflow runs async
      return c.json({ type: 6 });
    }

    // Unknown component — acknowledge without updating
    return c.json({ type: 6 });
  }

  // Unhandled interaction type — acknowledge with empty response
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

// ============================================================================
// Ticket Interaction Handlers
// ============================================================================

async function handleOpenTicket(env: Env, interaction: any): Promise<void> {
  const user = interaction.member?.user || interaction.user;
  const guildId = interaction.guild_id;
  const channelId = interaction.channel_id; // The channel where the panel lives
  const token = interaction.token;

  try {
    // 1. Create private thread in the panel's channel
    const threadName = `Ticket - ${user.username}`;
    const thread = await createPrivateThread(env.DISCORD_BOT_TOKEN, channelId, threadName);

    // 2. Add the user to the thread
    await addThreadMember(env.DISCORD_BOT_TOKEN, thread.id, user.id);

    // 3. Post welcome embed with Close button in the thread
    await sendMessageWithEmbed(env.DISCORD_BOT_TOKEN, thread.id, {
      embed: {
        title: 'Support Ticket',
        description: `Welcome <@${user.id}>! A support agent will be with you shortly.\n\nPlease describe your issue below.`,
        color: 0x5865F2,
        timestamp: new Date().toISOString(),
      },
      components: [
        {
          type: 1, // ACTION_ROW
          components: [
            {
              type: 2, // BUTTON
              style: 4, // DANGER
              label: 'Close Ticket',
              custom_id: 'close_ticket',
            },
          ],
        },
      ],
    });

    // 4. Create conversation in helpdesk-widget-api
    await fetch(`${env.HELPDESK_WIDGET_API_URL}/webhook/discord/ticket`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bot-Secret': env.DISCORD_PUBLIC_KEY,
      },
      body: JSON.stringify({
        guild_id: guildId,
        thread_id: thread.id,
        user: {
          id: user.id,
          username: user.username,
          avatar: user.avatar,
        },
      }),
    });

    // 5. Follow up interaction with ephemeral message
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
      // Best effort
    }
  }
}

async function handleCloseTicket(env: Env, interaction: any): Promise<void> {
  const threadId = interaction.channel_id; // The thread where the button was clicked
  const guildId = interaction.guild_id;
  const token = interaction.token;

  try {
    // 1. Close the conversation in helpdesk-widget-api
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

    // 2. Send "Ticket closed" message in thread
    await sendMessage(
      env.DISCORD_BOT_TOKEN,
      threadId,
      'This ticket has been closed. If you need further help, please open a new ticket.',
    );

    // 3. Archive + lock the thread
    await archiveThread(env.DISCORD_BOT_TOKEN, threadId);

    // 4. Follow up
    await followUpInteraction(
      env.DISCORD_APPLICATION_ID,
      token,
      'This ticket has been closed.',
    );
  } catch (err) {
    console.error('[Interactions] Failed to handle close_ticket:', err);
    try {
      await followUpInteraction(
        env.DISCORD_APPLICATION_ID,
        token,
        'Something went wrong closing the ticket. Please try again.',
      );
    } catch {
      // Best effort
    }
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

// ============================================================================
// Export
// ============================================================================

export default app;
