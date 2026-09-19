/**
 * Adopt first-party (`system`) tenant installs onto an official hosted WeldApp.
 * Mirrors app-api's adopt helpers so CLI `weld app publish` can backfill
 * installs without requiring every workspace to open the platform first.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import { keyringFromEnv } from '@weldsuite/db/lib/crypto';
import type { UserApp } from '@weldsuite/db/schema/master';
import { createMasterDb, masterSchema, type MasterDatabase } from '../lib/master-db';
import { createTenantDb, schema, type Database } from '../db';
import { generateId } from '../lib/id';
import type { Env } from '../types';

export type AdoptSystemInstallResult = 'adopted' | 'already' | 'none';

export async function adoptSystemInstallInTenant(params: {
  master: MasterDatabase;
  tenantDb: Database;
  app: UserApp;
  workspaceId: string;
  installedBy?: string | null;
}): Promise<AdoptSystemInstallResult> {
  const { master, tenantDb, app, workspaceId, installedBy } = params;
  if (app.deletedAt || !app.isActive) return 'none';
  if (app.visibility !== 'public' || app.reviewStatus !== 'approved') return 'none';
  const reserved = new Set([
    'weldcrm',
    'weldcommerce',
    'welddesk',
    'weldmail',
    'weldflow',
    'weldconnect',
    'weldstash',
    'weldhost',
    'weldbooks',
    'weldmeet',
    'weldchat',
    'weldagent',
  ]);
  if (app.publisherType !== 'weldsuite' && !reserved.has(app.code)) return 'none';

  const { workspaceInstalledApps } = schema;
  const { userAppInstalls, userApps } = masterSchema;

  const [tenantRow] = await tenantDb
    .select()
    .from(workspaceInstalledApps)
    .where(and(eq(workspaceInstalledApps.appCode, app.code), isNull(workspaceInstalledApps.deletedAt)))
    .limit(1);

  if (!tenantRow || !tenantRow.isActive) return 'none';

  if (tenantRow.appType === 'user' && tenantRow.userAppId === app.id) {
    const [install] = await master
      .select({ id: userAppInstalls.id, status: userAppInstalls.status })
      .from(userAppInstalls)
      .where(and(eq(userAppInstalls.appId, app.id), eq(userAppInstalls.workspaceId, workspaceId)))
      .limit(1);
    if (install?.status === 'active') return 'already';
  } else if (tenantRow.appType === 'user' && tenantRow.userAppId && tenantRow.userAppId !== app.id) {
    return 'none';
  } else if (tenantRow.appType !== 'system' && tenantRow.appType !== 'user') {
    return 'none';
  }

  const scopes = app.requestedScopes ?? [];
  const now = new Date();

  const [existing] = await master
    .select()
    .from(userAppInstalls)
    .where(and(eq(userAppInstalls.appId, app.id), eq(userAppInstalls.workspaceId, workspaceId)))
    .limit(1);

  let bumpInstallCount = false;
  if (existing) {
    if (existing.status !== 'active') {
      await master
        .update(userAppInstalls)
        .set({
          status: 'active',
          grantedScopes: scopes,
          pendingScopes: null,
          installedBy: installedBy ?? existing.installedBy,
          installedAt: now,
          revokedAt: null,
          updatedAt: now,
        })
        .where(eq(userAppInstalls.id, existing.id));
      bumpInstallCount = true;
    }
  } else {
    await master.insert(userAppInstalls).values({
      id: generateId('uai'),
      appId: app.id,
      workspaceId,
      status: 'active',
      grantedScopes: scopes,
      installedBy: installedBy || 'system',
      installedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    bumpInstallCount = true;
  }

  const alreadyLinked =
    tenantRow.appType === 'user' && tenantRow.userAppId === app.id && existing?.status === 'active';

  await tenantDb
    .update(workspaceInstalledApps)
    .set({
      appType: 'user',
      userAppId: app.id,
      grantedScopes: scopes,
      isActive: true,
      deletedAt: null,
      updatedAt: now,
      ...(installedBy ? { installedBy } : {}),
    })
    .where(eq(workspaceInstalledApps.id, tenantRow.id));

  if (bumpInstallCount) {
    await master
      .update(userApps)
      .set({ installCount: sql`${userApps.installCount} + 1`, updatedAt: now })
      .where(eq(userApps.id, app.id));
  }

  return alreadyLinked ? 'already' : 'adopted';
}

export async function sweepAdoptSystemInstallsForApp(params: {
  env: Env;
  app: UserApp;
  installedBy?: string | null;
}): Promise<{ adopted: number; failed: number }> {
  const { env, app, installedBy } = params;
  const reserved = new Set([
    'weldcrm',
    'weldcommerce',
    'welddesk',
    'weldmail',
    'weldflow',
    'weldconnect',
    'weldstash',
    'weldhost',
    'weldbooks',
    'weldmeet',
    'weldchat',
    'weldagent',
  ]);
  if (app.publisherType !== 'weldsuite' && !reserved.has(app.code)) {
    return { adopted: 0, failed: 0 };
  }

  const master = createMasterDb(env.HYPERDRIVE_MASTER);
  const workspaces = await master
    .select({
      id: masterSchema.workspaces.id,
      neonProjectId: masterSchema.workspaces.neonProjectId,
      neonBranchId: masterSchema.workspaces.neonBranchId,
      neonRoleName: masterSchema.workspaces.neonRoleName,
      neonDatabaseName: masterSchema.workspaces.neonDatabaseName,
      databaseUrl: masterSchema.workspaces.databaseUrl,
    })
    .from(masterSchema.workspaces)
    .where(isNull(masterSchema.workspaces.scheduledDeletionAt));

  let adopted = 0;
  let failed = 0;
  const keyring = keyringFromEnv(env);

  for (const ws of workspaces) {
    if (!ws.neonProjectId || !ws.neonBranchId || !ws.neonRoleName) {
      failed += 1;
      continue;
    }
    try {
      const databaseUrl = await resolveDatabaseUrl(
        env.NEON_API_KEY,
        {
          neonProjectId: ws.neonProjectId,
          neonBranchId: ws.neonBranchId,
          neonRoleName: ws.neonRoleName,
          neonDatabaseName: ws.neonDatabaseName,
          databaseUrl: ws.databaseUrl,
        },
        keyring,
      );
      const tenantDb = createTenantDb(databaseUrl);
      const result = await adoptSystemInstallInTenant({
        master,
        tenantDb,
        app,
        workspaceId: ws.id,
        installedBy,
      });
      if (result === 'adopted') adopted += 1;
    } catch (err) {
      failed += 1;
      console.error(`[external-api/user-apps] adopt sweep failed for workspace ${ws.id}:`, err);
    }
  }

  return { adopted, failed };
}
