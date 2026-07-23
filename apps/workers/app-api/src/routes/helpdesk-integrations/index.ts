/**
 * WeldDesk channel integrations — /api/helpdesk-integrations/*
 *
 * The authenticated management surface for the WeldDesk Discord/Slack support
 * channels, backed by the `helpdeskChannelIntegrations` table. Ported from
 * apps/api-worker/src/routes/helpdesk/integrations.ts (W5b of the legacy-worker
 * phase-out); the legacy mount was /api/helpdesk/integrations.
 *
 * DIFFERENT TABLE, DIFFERENT CONCEPT: /api/integrations serves
 * `integrationConnections` (Attio/HubSpot/Google Calendar/MCP). Never cross the
 * two — see the note in services/helpdesk-integrations.ts.
 *
 * The unauthenticated other half of the OAuth dance (the provider callbacks the
 * browser is redirected to) lives at /api/integrations/helpdesk/* —
 * routes/integrations/helpdesk-oauth.ts. The /connect endpoints here mint the
 * state nonce those callbacks consume, and both sides build redirect_uri from
 * helpdeskOAuthRedirectUri() so the two byte-match.
 *
 * PERMISSIONS — reads use `settings:read`, writes use `settings:update`.
 * The legacy route gated writes on `settings:create` / `settings:delete`, but
 * the `settings` object only defines read/update/manage
 * (packages/core/permissions/src/migration-map.ts: ['welddesk','settings','settings',
 * ['read','update','manage']]). Those keys match no role but OWNER's bare '*',
 * so every ADMIN hit the legacy connect/disconnect endpoints with a 403.
 * `settings:update` is the object's real write tier: OWNER + ADMIN pass,
 * MEMBER/VIEWER (who hold only `settings:read`) still cannot reconfigure a
 * channel. Reads stay MEMBER-reachable exactly as before.
 *
 * ENTITY EVENTS: there is no channel-integration entity type in the
 * @weldsuite/entity-events catalog (packages/core/entity-events/src/events/
 * helpdesk.ts), so no publishEntityEvent calls here — matching the legacy
 * route, which published none either.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import {
  getBotUser,
  getGuildChannels,
  refreshOAuthToken,
  sendMessage as discordSendMessage,
  sendMessageWithEmbed as discordSendMessageWithEmbed,
  setBotAvatar,
  setBotGuildNickname,
} from '../../services/integrations/discord';
import {
  discordGuildId,
  findIntegrationByIdOrProvider,
  findIntegrationByProvider,
  helpdeskOAuthRedirectUri,
  integrationConfig,
  listIntegrations,
  mergeChannelEnabledState,
  projectDiscordSettings,
  projectSlackSettings,
  sanitizeIntegration,
  slackAuthTest,
  slackBotToken,
  slackListChannels,
} from '../../services/helpdesk-integrations';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const hci = schema.helpdeskChannelIntegrations;

// ============================================================================
// Schemas
// ============================================================================

const saveTokenSchema = z.object({
  provider: z.string().min(1),
  token: z.string().min(1),
  config: z.record(z.unknown()).optional(),
});

const ticketPanelSchema = z.object({
  channelId: z.string(),
  channelName: z.string().optional(),
  embedTitle: z.string().max(256).default('Support Tickets'),
  embedDescription: z.string().max(4096).default('Click the button below to open a support ticket.'),
  embedColor: z.string().default('#5865F2'),
  buttonText: z.string().max(80).default('Open a Ticket'),
  buttonStyle: z.number().min(1).max(4).default(1),
  messageId: z.string().optional(),
});

const discordSettingsSchema = z.object({
  supportChannels: z
    .array(
      z.object({
        channelId: z.string(),
        channelName: z.string().optional(),
        enabled: z.boolean(),
      }),
    )
    .optional(),
  processDirectMessages: z.boolean().optional(),
  ignoreBots: z.boolean().optional(),
  supportPrefix: z.string().optional(),
  autoReplyMessage: z.string().optional(),
  botDisplayName: z.string().max(80).optional(),
  botAvatarUrl: z.string().url().optional().or(z.literal('')),
  ticketPanel: ticketPanelSchema.optional(),
});

const ticketPanelRequestSchema = z.object({
  channelId: z.string().min(1),
  channelName: z.string().optional(),
  embedTitle: z.string().max(256).default('Support Tickets'),
  embedDescription: z.string().max(4096).default('Click the button below to open a support ticket.'),
  embedColor: z.string().default('#5865F2'),
  buttonText: z.string().max(80).default('Open a Ticket'),
  buttonStyle: z.number().min(1).max(4).default(1),
});

const sendDiscordSchema = z.object({
  channelId: z.string().min(1),
  content: z.string().min(1),
  conversationId: z.string().optional(),
});

const slackSettingsSchema = z.object({
  supportChannels: z
    .array(
      z.object({
        channelId: z.string(),
        channelName: z.string().optional(),
        enabled: z.boolean(),
      }),
    )
    .optional(),
  ignoreBots: z.boolean().optional(),
});

// ============================================================================
// Shared helpers
// ============================================================================

/**
 * Mint a one-time OAuth state nonce in KV and return the provider authorize URL.
 * The nonce carries the caller's origin so the callback can redirect back to the
 * app the user actually started from (local dev against a deployed API).
 */
async function beginOAuth(
  c: AppContext,
  provider: 'discord' | 'slack',
  orgId: string,
): Promise<string> {
  const state = crypto.randomUUID();
  const callerOrigin =
    c.req.header('Origin') || c.req.header('Referer')?.replace(/\/[^/]*$/, '') || '';

  await c.env.WORKSPACE_CACHE.put(
    `${provider}_oauth_state:${state}`,
    JSON.stringify({ orgId, userId: c.get('userId'), callerOrigin }),
    { expirationTtl: 300 },
  );

  return state;
}

// ============================================================================
// GET / — list every channel integration
// ============================================================================

app.get('/', requirePermission('settings:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  try {
    const integrations = await listIntegrations(c.get('tenantDb'));
    return success(c, { integrations: integrations.map(sanitizeIntegration) });
  } catch (err) {
    console.error('[app-api/helpdesk-integrations] List error:', err);
    return error.internal(c);
  }
});

// ============================================================================
// POST /token — save a token-based integration (Telegram, …)
// ============================================================================

app.post(
  '/token',
  requirePermission('settings:update'),
  zValidator('json', saveTokenSchema),
  async (c) => {
    const orgId = c.get('orgId');
    if (!orgId) return error.orgRequired(c);

    const data = c.req.valid('json');

    try {
      const db = c.get('tenantDb');
      const existing = await findIntegrationByProvider(db, data.provider);
      const now = new Date();

      if (existing) {
        await db
          .update(hci)
          .set({
            accessToken: data.token,
            status: 'connected',
            config: (data.config || existing.config) as Record<string, unknown>,
            updatedAt: now,
            lastSyncAt: now,
            errorMessage: null,
          })
          .where(eq(hci.id, existing.id));

        return success(c, {
          ...sanitizeIntegration(existing),
          status: 'connected',
        });
      }

      const id = generateId('chi');
      await db.insert(hci).values({
        id,
        provider: data.provider,
        status: 'connected',
        name: data.provider.charAt(0).toUpperCase() + data.provider.slice(1),
        accessToken: data.token,
        config: (data.config || {}) as Record<string, unknown>,
        lastSyncAt: now,
        createdAt: now,
        updatedAt: now,
      });

      return success(c, { id, provider: data.provider, status: 'connected' }, 201);
    } catch (err) {
      console.error('[app-api/helpdesk-integrations] Save token error:', err);
      return error.internal(c);
    }
  },
);

// ============================================================================
// Discord — static routes (MUST precede the /:provider and /:id handlers)
// ============================================================================

/** POST /discord/connect — begin the Discord OAuth flow. */
app.post('/discord/connect', requirePermission('settings:update'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const clientId = c.env.DISCORD_CLIENT_ID;
  if (!clientId) return error.internal(c, 'Discord client ID not configured');

  try {
    const state = await beginOAuth(c, 'discord', orgId);

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: helpdeskOAuthRedirectUri(c.env, 'discord'),
      response_type: 'code',
      scope: 'identify bot guilds',
      // Send Messages + Read Messages + Read Message History + Change Nickname
      // + Manage Threads + Create Private Threads + Embed Links
      permissions: '360844446720',
      state,
    });

    return success(c, { authUrl: `https://discord.com/oauth2/authorize?${params.toString()}` });
  } catch (err) {
    console.error('[app-api/helpdesk-integrations] Discord connect error:', err);
    return error.internal(c);
  }
});

/** GET /discord/settings */
app.get('/discord/settings', requirePermission('settings:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  try {
    const integration = await findIntegrationByProvider(c.get('tenantDb'), 'discord');
    if (!integration) return error.notFound(c, 'Discord integration');

    return success(c, projectDiscordSettings(integrationConfig(integration)));
  } catch (err) {
    console.error('[app-api/helpdesk-integrations] Get Discord settings error:', err);
    return error.internal(c);
  }
});

/** PUT /discord/settings */
app.put(
  '/discord/settings',
  requirePermission('settings:update'),
  zValidator('json', discordSettingsSchema),
  async (c) => {
    const orgId = c.get('orgId');
    if (!orgId) return error.orgRequired(c);

    const data = c.req.valid('json');

    try {
      const db = c.get('tenantDb');
      const integration = await findIntegrationByProvider(db, 'discord');
      if (!integration) return error.notFound(c, 'Discord integration');

      const currentConfig = integrationConfig(integration);
      const updatedConfig: Record<string, unknown> = {
        ...currentConfig,
        ...(data.supportChannels !== undefined && { supportChannels: data.supportChannels }),
        ...(data.processDirectMessages !== undefined && {
          processDirectMessages: data.processDirectMessages,
        }),
        ...(data.ignoreBots !== undefined && { ignoreBots: data.ignoreBots }),
        ...(data.supportPrefix !== undefined && { supportPrefix: data.supportPrefix }),
        ...(data.autoReplyMessage !== undefined && { autoReplyMessage: data.autoReplyMessage }),
        ...(data.botDisplayName !== undefined && { botDisplayName: data.botDisplayName || '' }),
        ...(data.botAvatarUrl !== undefined && { botAvatarUrl: data.botAvatarUrl || '' }),
        ...(data.ticketPanel !== undefined && { ticketPanel: data.ticketPanel }),
      };

      await db
        .update(hci)
        .set({ config: updatedConfig, updatedAt: new Date() })
        .where(eq(hci.id, integration.id));

      const botToken = c.env.DISCORD_BOT_TOKEN;

      // Push the nickname to Discord. Non-fatal: the settings are already saved.
      if (data.botDisplayName !== undefined) {
        const guildId = discordGuildId(integration);
        if (botToken && guildId) {
          try {
            await setBotGuildNickname(botToken, guildId, data.botDisplayName || null);
          } catch (err) {
            console.error('[app-api/helpdesk-integrations] Failed to update bot nickname:', err);
          }
        }
      }

      // Push the avatar only when it actually changed — the Discord avatar
      // endpoint is heavily rate-limited. Non-fatal, same as above.
      if (data.botAvatarUrl !== undefined) {
        const previousAvatarUrl = (currentConfig.botAvatarUrl as string) || '';
        const newAvatarUrl = data.botAvatarUrl || '';
        if (botToken && previousAvatarUrl !== newAvatarUrl) {
          try {
            await setBotAvatar(botToken, newAvatarUrl || null);
          } catch (err) {
            console.error('[app-api/helpdesk-integrations] Failed to update bot avatar:', err);
          }
        }
      }

      return success(c, projectDiscordSettings(updatedConfig));
    } catch (err) {
      console.error('[app-api/helpdesk-integrations] Update Discord settings error:', err);
      return error.internal(c);
    }
  },
);

/** GET /discord/channels — live guild channels merged with configured state. */
app.get('/discord/channels', requirePermission('settings:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const botToken = c.env.DISCORD_BOT_TOKEN;
  if (!botToken) return error.internal(c, 'Discord bot token not configured');

  try {
    const integration = await findIntegrationByProvider(c.get('tenantDb'), 'discord');
    if (!integration) return error.notFound(c, 'Discord integration');

    const guildId = discordGuildId(integration);
    if (!guildId) return error.badRequest(c, 'No guild connected');

    const discordChannels = await getGuildChannels(botToken, guildId);
    const accountInfo = integration.accountInfo as { name?: string } | null;

    return success(c, {
      guildId,
      guildName: accountInfo?.name || 'Unknown',
      channels: mergeChannelEnabledState(discordChannels, integrationConfig(integration)),
    });
  } catch (err) {
    console.error('[app-api/helpdesk-integrations] Get Discord channels error:', err);
    return error.internal(c);
  }
});

/** POST /discord/ticket-panel — post the ticket-panel embed into a channel. */
app.post(
  '/discord/ticket-panel',
  requirePermission('settings:update'),
  zValidator('json', ticketPanelRequestSchema),
  async (c) => {
    const orgId = c.get('orgId');
    if (!orgId) return error.orgRequired(c);

    const botToken = c.env.DISCORD_BOT_TOKEN;
    if (!botToken) return error.internal(c, 'Discord bot token not configured');

    const data = c.req.valid('json');

    try {
      const db = c.get('tenantDb');
      const integration = await findIntegrationByProvider(db, 'discord');
      if (!integration) return error.notFound(c, 'Discord integration');

      const colorInt = parseInt(data.embedColor.replace('#', ''), 16) || 0x5865f2;

      const embed: Record<string, unknown> = {
        title: data.embedTitle,
        description: data.embedDescription,
        color: colorInt,
      };

      const components = [
        {
          type: 1, // ACTION_ROW
          components: [
            {
              type: 2, // BUTTON
              style: data.buttonStyle,
              label: data.buttonText,
              custom_id: 'open_ticket',
            },
          ],
        },
      ];

      const message = await discordSendMessageWithEmbed(botToken, data.channelId, embed, components);

      const ticketPanel = {
        channelId: data.channelId,
        channelName: data.channelName,
        embedTitle: data.embedTitle,
        embedDescription: data.embedDescription,
        embedColor: data.embedColor,
        buttonText: data.buttonText,
        buttonStyle: data.buttonStyle,
        messageId: message.id,
      };

      await db
        .update(hci)
        .set({
          config: { ...integrationConfig(integration), ticketPanel },
          updatedAt: new Date(),
        })
        .where(eq(hci.id, integration.id));

      return success(c, { messageId: message.id, ticketPanel });
    } catch (err) {
      console.error('[app-api/helpdesk-integrations] Post ticket panel error:', err);
      return error.internal(c, 'Failed to post ticket panel');
    }
  },
);

/** POST /discord/send — send a message to a Discord channel. */
app.post(
  '/discord/send',
  requirePermission('settings:update'),
  zValidator('json', sendDiscordSchema),
  async (c) => {
    const orgId = c.get('orgId');
    if (!orgId) return error.orgRequired(c);

    const botToken = c.env.DISCORD_BOT_TOKEN;
    if (!botToken) return error.internal(c, 'Discord bot token not configured');

    const data = c.req.valid('json');

    try {
      const message = await discordSendMessage(botToken, data.channelId, data.content);

      const db = c.get('tenantDb');
      const integration = await findIntegrationByProvider(db, 'discord');
      if (integration) {
        const now = new Date();
        await db
          .update(hci)
          .set({ lastSyncAt: now, updatedAt: now })
          .where(eq(hci.id, integration.id));
      }

      return success(c, { success: true, messageId: message.id, message: 'Message sent' });
    } catch (err) {
      console.error('[app-api/helpdesk-integrations] Send Discord message error:', err);
      return error.internal(c, 'Failed to send Discord message');
    }
  },
);

// ============================================================================
// Slack — static routes (MUST precede the /:provider and /:id handlers)
// ============================================================================

/** POST /slack/connect — begin the Slack OAuth flow. */
app.post('/slack/connect', requirePermission('settings:update'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const clientId = c.env.SLACK_CLIENT_ID;
  if (!clientId) return error.internal(c, 'Slack client ID not configured');

  try {
    const state = await beginOAuth(c, 'slack', orgId);

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: helpdeskOAuthRedirectUri(c.env, 'slack'),
      scope:
        'channels:history,channels:read,chat:write,im:history,im:read,im:write,users:read,users:read.email',
      state,
    });

    return success(c, { authUrl: `https://slack.com/oauth/v2/authorize?${params.toString()}` });
  } catch (err) {
    console.error('[app-api/helpdesk-integrations] Slack connect error:', err);
    return error.internal(c);
  }
});

/** GET /slack/settings */
app.get('/slack/settings', requirePermission('settings:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  try {
    const integration = await findIntegrationByProvider(c.get('tenantDb'), 'slack');
    if (!integration) return error.notFound(c, 'Slack integration');

    return success(c, projectSlackSettings(integrationConfig(integration)));
  } catch (err) {
    console.error('[app-api/helpdesk-integrations] Get Slack settings error:', err);
    return error.internal(c);
  }
});

/** PUT /slack/settings */
app.put(
  '/slack/settings',
  requirePermission('settings:update'),
  zValidator('json', slackSettingsSchema),
  async (c) => {
    const orgId = c.get('orgId');
    if (!orgId) return error.orgRequired(c);

    const data = c.req.valid('json');

    try {
      const db = c.get('tenantDb');
      const integration = await findIntegrationByProvider(db, 'slack');
      if (!integration) return error.notFound(c, 'Slack integration');

      const currentConfig = integrationConfig(integration);
      const updatedConfig: Record<string, unknown> = {
        ...currentConfig,
        supportChannels: data.supportChannels ?? currentConfig.supportChannels,
        ignoreBots: data.ignoreBots ?? currentConfig.ignoreBots,
      };

      await db
        .update(hci)
        .set({ config: updatedConfig, updatedAt: new Date() })
        .where(eq(hci.id, integration.id));

      return success(c, projectSlackSettings(updatedConfig));
    } catch (err) {
      console.error('[app-api/helpdesk-integrations] Update Slack settings error:', err);
      return error.internal(c);
    }
  },
);

/** GET /slack/channels — live Slack channels merged with configured state. */
app.get('/slack/channels', requirePermission('settings:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  try {
    const integration = await findIntegrationByProvider(c.get('tenantDb'), 'slack');
    if (!integration) return error.notFound(c, 'Slack integration');

    const botToken = slackBotToken(integration);
    if (!botToken) return error.badRequest(c, 'No bot token configured');

    const result = await slackListChannels(botToken);
    if (!result.ok) {
      console.error('[app-api/helpdesk-integrations] Slack channels error:', result.error);
      return error.internal(c, `Slack API error: ${result.error}`);
    }

    const accountInfo = (integration.accountInfo || {}) as { name?: string };

    return success(c, {
      teamName: accountInfo.name || 'Slack Workspace',
      channels: mergeChannelEnabledState(result.channels || [], integrationConfig(integration)),
    });
  } catch (err) {
    console.error('[app-api/helpdesk-integrations] Get Slack channels error:', err);
    return error.internal(c);
  }
});

/**
 * POST /slack/test — real auth.test probe.
 *
 * Registered ahead of `/:provider/test`, which in the legacy worker was
 * declared first and therefore swallowed every Slack test (the dedicated
 * handler below was unreachable dead code, and Slack always reported a
 * generic "connected" without contacting Slack at all).
 */
app.post('/slack/test', requirePermission('settings:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  try {
    const integration = await findIntegrationByProvider(c.get('tenantDb'), 'slack');
    if (!integration) return error.notFound(c, 'Slack integration');

    const botToken = slackBotToken(integration);
    if (!botToken) return error.badRequest(c, 'No bot token configured');

    const result = await slackAuthTest(botToken);
    if (!result.ok) {
      return success(c, { success: false, message: `Slack API error: ${result.error}` });
    }

    return success(c, {
      success: true,
      message: 'Connection is working',
      details: { botId: result.user_id, teamName: result.team },
    });
  } catch (err) {
    return success(c, { success: false, message: (err as Error).message });
  }
});

// ============================================================================
// Parameterised routes — every static route above MUST stay above these
// ============================================================================

/** POST /:provider/test — connection probe. */
app.post('/:provider/test', requirePermission('settings:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const provider = c.req.param('provider');

  try {
    if (provider === 'discord') {
      const botToken = c.env.DISCORD_BOT_TOKEN;
      if (!botToken) {
        return success(c, { success: false, message: 'Discord bot token not configured' });
      }
      const botUser = await getBotUser(botToken);
      return success(c, {
        success: true,
        message: `Connected as ${botUser.username}`,
        details: { botId: botUser.id, botName: botUser.username },
      });
    }

    const integration = await findIntegrationByProvider(c.get('tenantDb'), provider);
    if (!integration) {
      return success(c, { success: false, message: `No ${provider} integration found` });
    }

    return success(c, { success: true, message: `${provider} integration is connected` });
  } catch (err) {
    console.error(`[app-api/helpdesk-integrations] Test ${provider} error:`, err);
    return success(c, {
      success: false,
      message: err instanceof Error ? err.message : 'Connection test failed',
    });
  }
});

/** POST /:id/refresh — refresh an OAuth token. */
app.post('/:id/refresh', requirePermission('settings:update'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const id = c.req.param('id');

  try {
    const db = c.get('tenantDb');
    const integration = await findIntegrationByIdOrProvider(db, id);
    if (!integration) return error.notFound(c, 'Integration', id);

    if (integration.provider !== 'discord') {
      return error.badRequest(c, `Token refresh not supported for ${integration.provider}`);
    }

    const clientId = c.env.DISCORD_CLIENT_ID;
    const clientSecret = c.env.DISCORD_CLIENT_SECRET;
    if (!clientId || !clientSecret || !integration.refreshToken) {
      return error.badRequest(c, 'Cannot refresh token — missing credentials');
    }

    const tokens = await refreshOAuthToken(clientId, clientSecret, integration.refreshToken);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + tokens.expires_in * 1000);

    await db
      .update(hci)
      .set({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiresAt: expiresAt,
        status: 'connected',
        errorMessage: null,
        updatedAt: now,
      })
      .where(eq(hci.id, integration.id));

    return success(c, {
      ...sanitizeIntegration(integration),
      status: 'connected',
      tokenExpiresAt: expiresAt,
    });
  } catch (err) {
    console.error('[app-api/helpdesk-integrations] Refresh token error:', err);
    return error.internal(c, 'Failed to refresh token');
  }
});

/**
 * DELETE /:idOrProvider — soft-delete (disconnect) an integration.
 *
 * Accepts an integration id or a provider name; see
 * findIntegrationByIdOrProvider for why.
 */
app.delete('/:id', requirePermission('settings:update'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const id = c.req.param('id');

  try {
    const db = c.get('tenantDb');
    const integration = await findIntegrationByIdOrProvider(db, id);
    if (!integration) return error.notFound(c, 'Integration', id);

    // Drop the guild → workspace mapping the widget API resolves inbound
    // Discord events through, so a disconnected guild stops routing.
    if (integration.provider === 'discord') {
      const guildId = discordGuildId(integration);
      if (guildId) {
        await c.env.WORKSPACE_CACHE.delete(`discord_guild:${guildId}`);
      }
    }

    const now = new Date();
    await db
      .update(hci)
      .set({ deletedAt: now, status: 'disconnected', updatedAt: now })
      .where(eq(hci.id, integration.id));

    return success(c, { message: 'Disconnected' });
  } catch (err) {
    console.error('[app-api/helpdesk-integrations] Delete error:', err);
    return error.internal(c);
  }
});

/** GET /:provider — the integration for a provider. MUST stay last. */
app.get('/:provider', requirePermission('settings:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const provider = c.req.param('provider');

  try {
    const integration = await findIntegrationByProvider(c.get('tenantDb'), provider);
    if (!integration) return error.notFound(c, 'Integration', provider);

    return success(c, sanitizeIntegration(integration));
  } catch (err) {
    console.error('[app-api/helpdesk-integrations] Get error:', err);
    return error.internal(c);
  }
});

export const helpdeskIntegrationsRoutes = app;
