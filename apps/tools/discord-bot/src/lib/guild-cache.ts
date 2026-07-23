/**
 * Guild → Workspace mapping cache.
 *
 * Replaces the Cloudflare KV `WORKSPACE_CACHE` pattern from the old worker.
 * Looks up helpdeskChannelIntegrations to find the workspace for a given Discord guild.
 */

import { eq, and, isNull } from 'drizzle-orm';
import { getMasterDb } from './db.js';
import * as masterSchema from '@weldsuite/db/schema/master';

interface GuildMapping {
  clerkOrgId: string;
  internalWorkspaceId: string;
  cachedAt: number;
}

const guildCache = new Map<string, GuildMapping>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Resolve a Discord guild ID to a workspace.
 * Queries the master DB's workspace_discord_mappings or uses a cached value.
 */
export async function resolveGuild(guildId: string): Promise<GuildMapping | null> {
  const cached = guildCache.get(guildId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  const masterDb = getMasterDb();

  // Look up workspace that has this guild ID in their discord integration metadata
  // The master DB stores workspace → clerkOrgId mappings
  // We need to find which workspace owns this guild
  const allWorkspaces = await masterDb
    .select({
      id: masterSchema.workspaces.id,
      clerkOrgId: masterSchema.workspaces.clerkOrgId,
    })
    .from(masterSchema.workspaces)
    .where(eq(masterSchema.workspaces.isActive, true));

  // For each workspace, check if they have a discord integration with this guild
  // This is a startup/cache-miss path — not called frequently
  for (const ws of allWorkspaces) {
    if (!ws.clerkOrgId) continue;

    try {
      const { getTenantDb, schema } = await import('./db.js');
      const tenantDb = await getTenantDb(ws.clerkOrgId);

      const [integration] = await tenantDb
        .select()
        .from(schema.helpdeskChannelIntegrations)
        .where(
          and(
            eq(schema.helpdeskChannelIntegrations.provider, 'discord'),
            isNull(schema.helpdeskChannelIntegrations.deletedAt),
          ),
        )
        .limit(1);

      if (!integration || integration.status !== 'connected') continue;

      // Guild ID is stored in accountInfo.metadata.guildId (set by OAuth callback)
      const accountInfo = (integration.accountInfo || {}) as { id?: string; metadata?: Record<string, unknown> };
      const integrationGuildId = (accountInfo.metadata?.guildId as string) || accountInfo.id;

      if (integrationGuildId === guildId) {
        const mapping: GuildMapping = {
          clerkOrgId: ws.clerkOrgId,
          internalWorkspaceId: ws.id,
          cachedAt: Date.now(),
        };
        guildCache.set(guildId, mapping);
        return mapping;
      }
    } catch {
      // Non-fatal — skip workspace
    }
  }

  return null;
}

/**
 * Manually set a guild mapping (useful for bootstrapping).
 */
export function setGuildMapping(guildId: string, clerkOrgId: string, internalWorkspaceId: string): void {
  guildCache.set(guildId, {
    clerkOrgId,
    internalWorkspaceId,
    cachedAt: Date.now(),
  });
}

/**
 * Clear the guild cache (useful for testing).
 */
export function clearGuildCache(): void {
  guildCache.clear();
}
