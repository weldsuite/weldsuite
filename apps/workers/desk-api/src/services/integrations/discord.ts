/**
 * Discord REST API client — thin fetch() wrapper around Discord API v10.
 * Ported from apps/api-worker/src/lib/discord.ts.
 *
 * Consumers:
 *  - routes/integrations/helpdesk-oauth.ts (unauthenticated OAuth callback):
 *    exchangeOAuthCode + getGuild.
 *  - routes/helpdesk-integrations (authenticated management surface): the rest.
 *
 * Every function takes the bot token as its first argument (from
 * `c.env.DISCORD_BOT_TOKEN`) — no ambient credentials.
 */

const DISCORD_API_BASE = 'https://discord.com/api/v10';

export interface DiscordUser {
  id: string;
  username: string;
  discriminator: string;
  avatar: string | null;
  bot?: boolean;
}

export interface DiscordGuild {
  id: string;
  name: string;
  icon: string | null;
  owner_id: string;
  member_count?: number;
}

export interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  position: number;
  parent_id: string | null;
  topic: string | null;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  content: string;
  timestamp: string;
  author: DiscordUser;
}

export interface DiscordOAuthTokens {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
  guild?: DiscordGuild;
}

/** Discord snowflake IDs are decimal digit strings (max 20 digits today). */
const SNOWFLAKE_PATTERN = /^\d{1,25}$/;

/**
 * Guard for IDs interpolated into a Discord REST path, so a crafted value
 * can never add path segments (`../`, `?`, `#`) to the request URL.
 */
function snowflake(value: string, label: string): string {
  if (!SNOWFLAKE_PATTERN.test(value)) {
    throw new Error(`Invalid Discord ${label}`);
  }
  return value;
}

const PRIVATE_IPV4_PATTERN =
  /^(?:0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/**
 * Parse a user-supplied avatar URL and accept it only when it is a public
 * https address: no credentials, no localhost / internal host names and no
 * private or loopback IP literals.
 */
function parsePublicAvatarUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid avatar URL');
  }
  const host = url.hostname.toLowerCase();
  const isInternalHost =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.startsWith('[') ||
    PRIVATE_IPV4_PATTERN.test(host);
  if (url.protocol !== 'https:' || url.username || url.password || isInternalHost) {
    throw new Error('Avatar URL must be a public https URL');
  }
  return url;
}

async function discordFetch<T>(url: string, options: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord API error (${response.status}): ${text}`);
  }
  return response.json() as Promise<T>;
}

/** GET /guilds/{guild_id} — guild info. */
export async function getGuild(botToken: string, guildId: string): Promise<DiscordGuild> {
  return discordFetch<DiscordGuild>(`${DISCORD_API_BASE}/guilds/${snowflake(guildId, 'guild id')}`, {
    headers: { Authorization: `Bot ${botToken}` },
  });
}

/** Exchange an OAuth2 authorization code for tokens. */
export async function exchangeOAuthCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<DiscordOAuthTokens> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });

  return discordFetch<DiscordOAuthTokens>(`${DISCORD_API_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
}

/** Refresh an OAuth2 access token. */
export async function refreshOAuthToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<DiscordOAuthTokens> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  return discordFetch<DiscordOAuthTokens>(`${DISCORD_API_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
}

/** GET /users/@me — verify the bot token and read the bot identity. */
export async function getBotUser(botToken: string): Promise<DiscordUser> {
  return discordFetch<DiscordUser>(`${DISCORD_API_BASE}/users/@me`, {
    headers: { Authorization: `Bot ${botToken}` },
  });
}

/** GET /guilds/{guild_id}/channels — text channels only (type 0). */
export async function getGuildChannels(botToken: string, guildId: string): Promise<DiscordChannel[]> {
  const channels = await discordFetch<DiscordChannel[]>(
    `${DISCORD_API_BASE}/guilds/${snowflake(guildId, 'guild id')}/channels`,
    { headers: { Authorization: `Bot ${botToken}` } },
  );
  return channels.filter((ch) => ch.type === 0);
}

/** POST /channels/{channel_id}/messages — send a plain-text message. */
export async function sendMessage(
  botToken: string,
  channelId: string,
  content: string,
): Promise<DiscordMessage> {
  return discordFetch<DiscordMessage>(`${DISCORD_API_BASE}/channels/${snowflake(channelId, 'channel id')}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });
}

/** POST /channels/{channel_id}/messages — send an embed (+ optional components). */
export async function sendMessageWithEmbed(
  botToken: string,
  channelId: string,
  embed: Record<string, unknown>,
  components?: unknown[],
): Promise<DiscordMessage> {
  const body: Record<string, unknown> = { embeds: [embed] };
  if (components) body.components = components;

  return discordFetch<DiscordMessage>(`${DISCORD_API_BASE}/channels/${snowflake(channelId, 'channel id')}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

/**
 * PATCH /guilds/{guild_id}/members/@me — set the bot's nickname in a guild.
 * Pass null/'' to reset to the default bot username. Needs CHANGE_NICKNAME.
 */
export async function setBotGuildNickname(
  botToken: string,
  guildId: string,
  nickname: string | null,
): Promise<void> {
  const response = await fetch(`${DISCORD_API_BASE}/guilds/${snowflake(guildId, 'guild id')}/members/@me`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ nick: nickname || '' }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord API error (${response.status}): ${text}`);
  }
}

/**
 * PATCH /users/@me — set the bot's global avatar. Pass a URL to fetch and
 * convert to a base64 data URI, or null to reset.
 */
export async function setBotAvatar(botToken: string, avatarUrl: string | null): Promise<void> {
  let avatar: string | null = null;

  if (avatarUrl) {
    const imageResponse = await fetch(parsePublicAvatarUrl(avatarUrl).toString());
    if (!imageResponse.ok) {
      throw new Error(`Failed to fetch avatar image (${imageResponse.status})`);
    }
    // Strip charset etc. from the mime type.
    const rawContentType = imageResponse.headers.get('content-type') || 'image/png';
    const contentType = rawContentType.split(';')[0].trim();
    const bytes = new Uint8Array(await imageResponse.arrayBuffer());

    // Chunked base64 — avoids a stack overflow on large buffers.
    const chunkSize = 8192;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCodePoint(...bytes.subarray(i, i + chunkSize));
    }
    avatar = `data:${contentType};base64,${btoa(binary)}`;
  }

  const response = await fetch(`${DISCORD_API_BASE}/users/@me`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ avatar }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord API error (${response.status}): ${text}`);
  }
}
