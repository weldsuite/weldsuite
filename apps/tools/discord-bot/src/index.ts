/**
 * Discord Bot — Entry Point
 *
 * Runs on Hetzner as a long-lived Node.js process:
 * 1. Discord.js client — persistent Gateway WebSocket for messages + interactions
 * 2. Hono HTTP server — health check + management endpoints
 */

import { Client, GatewayIntentBits, Events, REST, Routes } from 'discord.js';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { getEnv } from './lib/env.js';
import { handleMessage } from './handlers/message.js';
import { handleInteraction } from './handlers/interaction.js';
import { commands, handleCommand } from './handlers/commands.js';
import { handleTypingStart } from './handlers/typing.js';
import { handlePresenceUpdate } from './handlers/presence.js';

const env = getEnv();

// ============================================================================
// Discord Gateway Client
// ============================================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageTyping,
    // Privileged — also enable in Discord Developer Portal → Bot → Privileged
    // Gateway Intents. GuildPresences delivers online/offline transitions;
    // GuildMembers keeps the member cache warm so we can resolve usernames.
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[Discord] Logged in as ${readyClient.user.tag}`);
  console.log(`[Discord] Serving ${readyClient.guilds.cache.size} guilds`);

  // Register slash commands
  try {
    const rest = new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN);
    await rest.put(
      Routes.applicationCommands(env.DISCORD_APPLICATION_ID),
      { body: commands },
    );
    console.log(`[Discord] Registered ${commands.length} slash command(s)`);
  } catch (err) {
    console.error('[Discord] Failed to register commands:', err);
  }
});

client.on(Events.MessageCreate, handleMessage);
client.on(Events.TypingStart, handleTypingStart);
client.on(Events.PresenceUpdate, handlePresenceUpdate);

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    await handleCommand(interaction);
  } else {
    await handleInteraction(interaction);
  }
});

client.on(Events.Error, (err) => {
  console.error('[Discord] Client error:', err);
});

client.on(Events.Warn, (msg) => {
  console.warn('[Discord] Warning:', msg);
});

client.login(env.DISCORD_BOT_TOKEN);

// ============================================================================
// Hono HTTP Server (Health + Management)
// ============================================================================

const app = new Hono();

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'discord-bot',
    environment: env.ENVIRONMENT,
    discord: {
      connected: client.isReady(),
      user: client.user?.tag || null,
      guilds: client.guilds.cache.size,
      uptime: client.uptime,
    },
  });
});

app.get('/robots.txt', (c) => {
  return c.text('User-agent: *\nDisallow: /\n');
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`[HTTP] Server listening on port ${info.port}`);
});
