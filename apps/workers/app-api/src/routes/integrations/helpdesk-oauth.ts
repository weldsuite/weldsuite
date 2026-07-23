/**
 * Helpdesk OAuth callbacks — UNAUTHENTICATED browser-redirect endpoints for
 * the WeldDesk Discord and Slack channel integrations. Ported from
 * apps/api-worker/src/routes/integrations/index.ts (helpdeskOAuthRoutes).
 *
 * Mount at /api/integrations/helpdesk BEFORE the global /api/* Clerk guard —
 * the user's browser is redirected here by Discord/Slack, so there is no
 * Clerk JWT. Auth is the one-time state nonce stashed in KV by the authorize
 * initiation endpoint (POST /api/helpdesk-integrations/{discord,slack}/connect,
 * WeldDesk settings surface).
 *
 * CUTOVER NOTE: the redirect URIs registered on the Discord/Slack OAuth apps
 * must include the app-api callback URLs built by helpdeskOAuthRedirectUri()
 * before traffic can move off api-worker. The authorize step (W5b) already
 * builds redirect_uri from that same helper, so the two byte-match by
 * construction.
 */

import { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import type { Env } from '../../types';
import { generateId } from '../../lib/id';
import { getTenantDbForWorkspace, getWorkspaceForOrg, schema } from '../../db';
import { exchangeOAuthCode, getGuild } from '../../services/integrations/discord';
import {
  getHelpdeskAppUrl as getAppUrl,
  helpdeskOAuthRedirectUri,
} from '../../services/helpdesk-integrations';
import type { IntegrationsEnv } from '../../services/integrations/connections';

const app = new Hono<{ Bindings: Env }>();

// ============================================================================
// GET /discord/callback?code=...&state=...&guild_id=...
// ============================================================================

app.get('/discord/callback', async (c) => {
  const env = c.env as IntegrationsEnv;
  const code = c.req.query('code');
  const state = c.req.query('state');
  const guildId = c.req.query('guild_id');
  const defaultAppUrl = getAppUrl(env);

  if (!code || !state) {
    return c.redirect(`${defaultAppUrl}/welddesk/settings/integrations/discord?error=missing_params`);
  }

  let appUrl = defaultAppUrl;
  try {
    // 1. Validate state from KV
    const stateKey = `discord_oauth_state:${state}`;
    const stateData = (await env.WORKSPACE_CACHE.get(stateKey, 'json')) as {
      orgId: string;
      userId: string;
      callerOrigin?: string;
    } | null;

    if (!stateData) {
      return c.redirect(`${defaultAppUrl}/welddesk/settings/integrations/discord?error=invalid_state`);
    }

    // Delete used state
    await env.WORKSPACE_CACHE.delete(stateKey);

    // Use the caller's origin if available (supports local dev against test API)
    appUrl = stateData.callerOrigin || defaultAppUrl;
    const { orgId } = stateData;

    const clientId = env.DISCORD_CLIENT_ID;
    const clientSecret = env.DISCORD_CLIENT_SECRET;
    const botToken = env.DISCORD_BOT_TOKEN;
    if (!clientId || !clientSecret) {
      return c.redirect(`${appUrl}/welddesk/settings/integrations/discord?error=config_error`);
    }

    // 2. Exchange code for tokens
    const redirectUri = helpdeskOAuthRedirectUri(env, 'discord');
    const tokens = await exchangeOAuthCode(clientId, clientSecret, code, redirectUri);

    // 3. Get guild info (use guild from OAuth response or query param)
    const resolvedGuildId = tokens.guild?.id || guildId;
    let guildName = tokens.guild?.name || 'Discord Server';

    if (resolvedGuildId && botToken) {
      try {
        const guild = await getGuild(botToken, resolvedGuildId);
        guildName = guild.name;
      } catch {
        // Guild info fetch is non-critical
      }
    }

    // 4. Get workspace ID for this org
    const workspace = await getWorkspaceForOrg(env, orgId);

    // 5. Get tenant DB and upsert integration
    const db = await getTenantDbForWorkspace(env, orgId);
    const hci = schema.helpdeskChannelIntegrations;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + tokens.expires_in * 1000);

    // Check for existing Discord integration
    const [existing] = await db
      .select()
      .from(hci)
      .where(and(eq(hci.provider, 'discord'), isNull(hci.deletedAt)))
      .limit(1);

    if (existing) {
      await db
        .update(hci)
        .set({
          status: 'connected',
          accountInfo: {
            id: resolvedGuildId || 'unknown',
            name: guildName,
            metadata: { guildId: resolvedGuildId, guildName },
          },
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          tokenExpiresAt: expiresAt,
          errorMessage: null,
          lastSyncAt: now,
          updatedAt: now,
        } as Partial<typeof hci.$inferInsert>)
        .where(eq(hci.id, existing.id));
    } else {
      const id = generateId('chi');
      await db.insert(hci).values({
        id,
        provider: 'discord',
        status: 'connected',
        name: guildName,
        accountInfo: {
          id: resolvedGuildId || 'unknown',
          name: guildName,
          metadata: { guildId: resolvedGuildId, guildName },
        },
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiresAt: expiresAt,
        config: {
          supportChannels: [],
          processDirectMessages: false,
          ignoreBots: true,
        },
        lastSyncAt: now,
        createdAt: now,
        updatedAt: now,
      } as unknown as typeof hci.$inferInsert);
    }

    // 6. Store KV mapping for helpdesk-widget-api: discord_guild:{guildId} → workspace info
    if (resolvedGuildId) {
      await env.WORKSPACE_CACHE.put(
        `discord_guild:${resolvedGuildId}`,
        JSON.stringify({ clerkOrgId: orgId, internalWorkspaceId: workspace.id }),
        { expirationTtl: 86400 * 365 }, // 1 year
      );
    }

    // 7. Redirect back to app
    return c.redirect(`${appUrl}/welddesk/settings/integrations/discord?connected=true`);
  } catch (err) {
    console.error('[app-api/integrations-helpdesk] Discord OAuth callback error:', err);
    return c.redirect(`${appUrl}/welddesk/settings/integrations/discord?error=callback_failed`);
  }
});

// ============================================================================
// GET /slack/callback?code=...&state=...
// ============================================================================

app.get('/slack/callback', async (c) => {
  const env = c.env as IntegrationsEnv;
  const code = c.req.query('code');
  const state = c.req.query('state');
  const defaultAppUrl = getAppUrl(env);

  if (!code || !state) {
    return c.redirect(`${defaultAppUrl}/welddesk/settings/integrations/slack?error=missing_params`);
  }

  try {
    // 1. Validate state
    const stateKey = `slack_oauth_state:${state}`;
    const stateData = (await env.WORKSPACE_CACHE.get(stateKey, 'json')) as {
      orgId: string;
      userId: string;
      callerOrigin?: string;
    } | null;

    if (!stateData) {
      return c.redirect(`${defaultAppUrl}/welddesk/settings/integrations/slack?error=invalid_state`);
    }

    await env.WORKSPACE_CACHE.delete(stateKey);
    const appUrl = stateData.callerOrigin || defaultAppUrl;
    const { orgId } = stateData;

    const clientId = env.SLACK_CLIENT_ID;
    const clientSecret = env.SLACK_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return c.redirect(`${appUrl}/welddesk/settings/integrations/slack?error=config_error`);
    }

    // 2. Exchange code for token
    const redirectUri = helpdeskOAuthRedirectUri(env, 'slack');

    const tokenRes = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    const tokenData = (await tokenRes.json()) as {
      ok: boolean;
      access_token?: string;
      token_type?: string;
      team?: { id: string; name: string };
      bot_user_id?: string;
      error?: string;
    };

    if (!tokenData.ok || !tokenData.access_token) {
      console.error('[app-api/integrations-helpdesk] Slack token exchange failed:', tokenData.error);
      return c.redirect(`${appUrl}/welddesk/settings/integrations/slack?error=${tokenData.error || 'token_exchange_failed'}`);
    }

    const teamId = tokenData.team?.id;
    const teamName = tokenData.team?.name || 'Slack Workspace';
    const botToken = tokenData.access_token;

    // 3. Get workspace
    const workspace = await getWorkspaceForOrg(env, orgId);
    const db = await getTenantDbForWorkspace(env, orgId);
    const hci = schema.helpdeskChannelIntegrations;

    // 4. Upsert integration record
    const [existing] = await db
      .select()
      .from(hci)
      .where(and(eq(hci.provider, 'slack'), isNull(hci.deletedAt)))
      .limit(1);

    const now = new Date();
    const integrationData = {
      status: 'connected',
      name: teamName,
      accountInfo: {
        id: teamId || 'unknown',
        name: teamName,
        metadata: { teamId, botUserId: tokenData.bot_user_id },
      },
      config: {
        ...((existing?.config as Record<string, unknown>) || {}),
        botToken,
      },
      accessToken: botToken,
      updatedAt: now,
    };

    if (existing) {
      await db
        .update(hci)
        .set(integrationData as Partial<typeof hci.$inferInsert>)
        .where(eq(hci.id, existing.id));
    } else {
      await db.insert(hci).values({
        id: generateId('chi'),
        provider: 'slack',
        ...integrationData,
        createdAt: now,
      } as unknown as typeof hci.$inferInsert);
    }

    // 5. Store KV mapping for team → workspace resolution
    if (teamId) {
      await env.WORKSPACE_CACHE.put(
        `slack_team:${teamId}`,
        JSON.stringify({ clerkOrgId: orgId, internalWorkspaceId: workspace.id }),
        { expirationTtl: 365 * 24 * 60 * 60 }, // 1 year
      );
    }

    console.log(`[app-api/integrations-helpdesk] Connected Slack team "${teamName}" (${teamId}) for org ${orgId}`);

    return c.redirect(`${appUrl}/welddesk/settings/integrations/slack?connected=true`);
  } catch (err) {
    console.error('[app-api/integrations-helpdesk] Slack OAuth callback error:', err);
    return c.redirect(`${defaultAppUrl}/welddesk/settings/integrations/slack?error=callback_failed`);
  }
});

export const integrationsHelpdeskOAuthRoutes = app;
