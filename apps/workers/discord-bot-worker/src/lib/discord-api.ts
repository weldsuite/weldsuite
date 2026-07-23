/**
 * Discord REST API helpers for the bot worker.
 *
 * Thin fetch wrappers around Discord API v10 used by interaction handlers.
 */

const DISCORD_API = 'https://discord.com/api/v10';

interface DiscordApiMessage {
  id: string;
  channel_id: string;
  content: string;
}

interface DiscordThread {
  id: string;
  name: string;
  type: number;
}

async function discordFetch<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord API error (${res.status}): ${text}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Create a private thread in a channel.
 * type 12 = GUILD_PRIVATE_THREAD
 */
export async function createPrivateThread(
  botToken: string,
  channelId: string,
  name: string,
): Promise<DiscordThread> {
  return discordFetch<DiscordThread>(
    `${DISCORD_API}/channels/${channelId}/threads`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: name.slice(0, 100),
        type: 12, // GUILD_PRIVATE_THREAD
        invitable: false,
      }),
    },
  );
}

/**
 * Add a user to a thread.
 */
export async function addThreadMember(
  botToken: string,
  threadId: string,
  userId: string,
): Promise<void> {
  const res = await fetch(
    `${DISCORD_API}/channels/${threadId}/thread-members/${userId}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bot ${botToken}` },
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord API error (${res.status}): ${text}`);
  }
}

/**
 * Send a message with embed and optional components (buttons).
 */
export async function sendMessageWithEmbed(
  botToken: string,
  channelId: string,
  options: {
    content?: string;
    embed?: Record<string, unknown>;
    components?: unknown[];
  },
): Promise<DiscordApiMessage> {
  const body: Record<string, unknown> = {};
  if (options.content) body.content = options.content;
  if (options.embed) body.embeds = [options.embed];
  if (options.components) body.components = options.components;

  return discordFetch<DiscordApiMessage>(
    `${DISCORD_API}/channels/${channelId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
}

/**
 * Send a simple text message.
 */
export async function sendMessage(
  botToken: string,
  channelId: string,
  content: string,
): Promise<DiscordApiMessage> {
  return discordFetch<DiscordApiMessage>(
    `${DISCORD_API}/channels/${channelId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content }),
    },
  );
}

/**
 * Archive and lock a thread.
 */
export async function archiveThread(
  botToken: string,
  threadId: string,
): Promise<void> {
  const res = await fetch(
    `${DISCORD_API}/channels/${threadId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ archived: true, locked: true }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord API error (${res.status}): ${text}`);
  }
}

/**
 * Follow-up on a deferred interaction by editing the original response.
 */
export async function followUpInteraction(
  appId: string,
  interactionToken: string,
  content: string,
  ephemeral = true,
): Promise<void> {
  const body: Record<string, unknown> = { content };
  if (ephemeral) body.flags = 64; // EPHEMERAL

  const res = await fetch(
    `${DISCORD_API}/webhooks/${appId}/${interactionToken}/messages/@original`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord API followup error (${res.status}): ${text}`);
  }
}
