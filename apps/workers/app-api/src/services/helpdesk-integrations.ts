/**
 * WeldDesk channel integrations — service layer for `helpdeskChannelIntegrations`.
 *
 * NOTE ON TABLES: this is the WeldDesk *channel* surface (Discord/Slack support
 * channels). It is NOT `integrationConnections` (Attio/HubSpot/Google Calendar/
 * MCP), which is served by services/integrations/connections.ts and the
 * /api/integrations router. The two tables and concepts must never be crossed.
 *
 * Ported from apps/api-worker/src/routes/helpdesk/integrations.ts (read-only
 * reference). Pure functions — no Hono context.
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../db';
import { schema } from '../db';
import type { Env } from '../types';

const hci = schema.helpdeskChannelIntegrations;

export type HelpdeskIntegration = typeof hci.$inferSelect;

// ============================================================================
// OAuth URL builders
//
// The redirect_uri sent on the authorize step MUST byte-match the one the
// token exchange replays, so both the /connect endpoints (routes/
// helpdesk-integrations) and the callbacks (routes/integrations/helpdesk-oauth)
// build it from these single definitions. Do not inline copies.
// ============================================================================

/** Public base URL of THIS worker (app-api) per environment. Override with APP_API_PUBLIC_URL. */
export function getHelpdeskWorkerUrl(env: Env): string {
  const override = (env as unknown as Record<string, string | undefined>).APP_API_PUBLIC_URL;
  if (override) return override.replace(/\/$/, '');
  const urls: Record<string, string> = {
    development: 'http://localhost:8789',
    test: 'https://app-api-test.weldsuite.org',
    // preview has no custom domain (wrangler.toml [env.preview] declares no
    // routes), so preview borrows the TEST app-api hostname — same stance as
    // workflow-worker/wrangler.toml. There is no app-api-preview.* host.
    preview: 'https://app-api-test.weldsuite.org',
    production: 'https://app-api.weldsuite.org',
  };
  return urls[env.ENVIRONMENT] || urls.development;
}

/** Platform SPA base URL per environment (redirect target after OAuth). */
export function getHelpdeskAppUrl(env: Env): string {
  if (env.PUBLIC_APP_URL) return env.PUBLIC_APP_URL.replace(/\/$/, '');
  const urls: Record<string, string> = {
    development: 'http://localhost:3000',
    test: 'https://app-test.weldsuite.org',
    preview: 'https://app-preview.weldsuite.org',
    production: 'https://app.weldsuite.org',
  };
  return urls[env.ENVIRONMENT] || urls.development;
}

/**
 * The provider callback URL. Must be registered verbatim on the Discord/Slack
 * OAuth apps for the environment in question.
 */
export function helpdeskOAuthRedirectUri(env: Env, provider: 'discord' | 'slack'): string {
  return `${getHelpdeskWorkerUrl(env)}/api/integrations/helpdesk/${provider}/callback`;
}

// ============================================================================
// Row access
// ============================================================================

/** Every live integration, newest first. */
export async function listIntegrations(db: Database): Promise<HelpdeskIntegration[]> {
  return db.select().from(hci).where(isNull(hci.deletedAt)).orderBy(desc(hci.createdAt));
}

/** The live integration for a provider, or undefined. */
export async function findIntegrationByProvider(
  db: Database,
  provider: string,
): Promise<HelpdeskIntegration | undefined> {
  const [row] = await db
    .select()
    .from(hci)
    .where(and(eq(hci.provider, provider), isNull(hci.deletedAt)))
    .limit(1);
  return row;
}

/** The live integration for an id, or undefined. */
export async function findIntegrationById(
  db: Database,
  id: string,
): Promise<HelpdeskIntegration | undefined> {
  const [row] = await db
    .select()
    .from(hci)
    .where(and(eq(hci.id, id), isNull(hci.deletedAt)))
    .limit(1);
  return row;
}

/**
 * Resolve by id, falling back to provider name.
 *
 * The legacy api-worker surface was asymmetric — `GET /:provider` looked up by
 * provider while `DELETE /:id` looked up by id — so the WeldDesk settings pages,
 * which only ever had the provider to hand, 404'd on disconnect. Accepting both
 * is a superset of the legacy contract: existing id callers are unaffected.
 */
export async function findIntegrationByIdOrProvider(
  db: Database,
  idOrProvider: string,
): Promise<HelpdeskIntegration | undefined> {
  return (
    (await findIntegrationById(db, idOrProvider)) ??
    (await findIntegrationByProvider(db, idOrProvider))
  );
}

/** Strip secrets before any row crosses the wire. */
export function sanitizeIntegration(row: HelpdeskIntegration) {
  const { accessToken: _accessToken, refreshToken: _refreshToken, ...safe } = row;
  return safe;
}

/** A row's `config` JSONB as a plain bag. */
export function integrationConfig(row: HelpdeskIntegration): Record<string, unknown> {
  return (row.config || {}) as Record<string, unknown>;
}

/** The guild id recorded on a Discord integration's accountInfo metadata. */
export function discordGuildId(row: HelpdeskIntegration): string | undefined {
  const accountInfo = row.accountInfo as { metadata?: Record<string, unknown> } | null;
  return accountInfo?.metadata?.guildId as string | undefined;
}

// ============================================================================
// Settings projections — the exact shapes the platform consumes
// ============================================================================

export interface DiscordSettingsView {
  supportChannels: unknown;
  processDirectMessages: boolean;
  ignoreBots: boolean;
  supportPrefix: string;
  autoReplyMessage: string;
  botDisplayName: string;
  botAvatarUrl: string;
  ticketPanel: unknown;
}

export function projectDiscordSettings(config: Record<string, unknown>): DiscordSettingsView {
  return {
    supportChannels: config.supportChannels || [],
    processDirectMessages: (config.processDirectMessages as boolean) ?? false,
    ignoreBots: (config.ignoreBots as boolean) ?? true,
    supportPrefix: (config.supportPrefix as string) || '',
    autoReplyMessage: (config.autoReplyMessage as string) || '',
    botDisplayName: (config.botDisplayName as string) || '',
    botAvatarUrl: (config.botAvatarUrl as string) || '',
    ticketPanel: config.ticketPanel || null,
  };
}

export interface SlackSettingsView {
  supportChannels: unknown;
  ignoreBots: boolean;
}

export function projectSlackSettings(config: Record<string, unknown>): SlackSettingsView {
  return {
    supportChannels: config.supportChannels || [],
    ignoreBots: (config.ignoreBots as boolean) ?? true,
  };
}

/**
 * Merge the configured enabled-state onto the provider's live channel list.
 * Channels the workspace has never configured default to disabled.
 */
export function mergeChannelEnabledState(
  providerChannels: Array<{ id: string; name: string }>,
  config: Record<string, unknown>,
): Array<{ channelId: string; channelName: string; enabled: boolean }> {
  const supportChannels = (config.supportChannels || []) as Array<{
    channelId: string;
    enabled: boolean;
  }>;
  const enabledMap = new Map(supportChannels.map((ch) => [ch.channelId, ch.enabled]));
  return providerChannels.map((ch) => ({
    channelId: ch.id,
    channelName: ch.name,
    enabled: enabledMap.get(ch.id) ?? false,
  }));
}

// ============================================================================
// Slack Web API — the small slice this surface needs
// ============================================================================

/** The bot token Slack integrations authenticate with (stored on `config`). */
export function slackBotToken(row: HelpdeskIntegration): string | undefined {
  return integrationConfig(row).botToken as string | undefined;
}

export interface SlackAuthTest {
  ok: boolean;
  user_id?: string;
  team?: string;
  error?: string;
}

/** POST-less auth.test probe — verifies the bot token still works. */
export async function slackAuthTest(botToken: string): Promise<SlackAuthTest> {
  const response = await fetch('https://slack.com/api/auth.test', {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  return (await response.json()) as SlackAuthTest;
}

export interface SlackChannelList {
  ok: boolean;
  channels?: Array<{ id: string; name: string }>;
  error?: string;
}

/** conversations.list — public, non-archived channels (max 200). */
export async function slackListChannels(botToken: string): Promise<SlackChannelList> {
  const response = await fetch(
    'https://slack.com/api/conversations.list?types=public_channel&exclude_archived=true&limit=200',
    { headers: { Authorization: `Bearer ${botToken}` } },
  );
  return (await response.json()) as SlackChannelList;
}
