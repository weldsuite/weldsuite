/**
 * Discord REST API client (v10) — outbound subset.
 *
 * Ported from api-worker `src/lib/discord.ts` (W5b legacy-worker phase-out).
 * Only the two helpers the WeldDesk conversation surface needs are carried
 * over: sending a reply into a Discord channel/thread, and archiving a ticket
 * thread when the conversation closes. The OAuth / guild-introspection half of
 * the legacy file belongs to the Discord *integration* surface and stays where
 * it is until that route is ported.
 */

const DISCORD_API_BASE = 'https://discord.com/api/v10';

export interface DiscordMessage {
  id: string;
  channel_id: string;
  content: string;
  timestamp: string;
}

async function discordFetch<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord API error (${response.status}): ${text}`);
  }
  return (await response.json()) as T;
}

/** POST /channels/{channel_id}/messages — send a message. */
export async function sendMessage(
  botToken: string,
  channelId: string,
  content: string,
): Promise<DiscordMessage> {
  return discordFetch<DiscordMessage>(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });
}

/** PATCH /channels/{channel_id} — archive and lock a thread. */
export async function archiveThread(botToken: string, threadId: string): Promise<void> {
  const response = await fetch(`${DISCORD_API_BASE}/channels/${threadId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ archived: true, locked: true }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord API error (${response.status}): ${text}`);
  }
}
