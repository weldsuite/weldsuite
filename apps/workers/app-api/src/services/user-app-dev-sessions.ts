/**
 * Per-developer preview sessions for `weld app dev`.
 *
 * The URL allowlist lives in `@weldsuite/app-api-client/schemas/user-apps`
 * (shared with external-api). This module owns the master-DB upsert.
 */

import { and, eq, gt, isNull } from 'drizzle-orm';
import {
  DEV_SESSION_TTL_MS,
  isAllowedDevSessionUrl,
} from '@weldsuite/app-api-client/schemas/user-apps';
import { masterSchema, type MasterDatabase } from '../db';
import { generateId } from '../lib/id';

export { DEV_SESSION_TTL_MS, isAllowedDevSessionUrl };

const uSessions = masterSchema.userAppDevSessions;
const uApps = masterSchema.userApps;

export interface DevSessionView {
  url: string;
  expiresAt: Date;
}

export async function upsertDevSession(
  master: MasterDatabase,
  params: {
    appId: string;
    workspaceId: string;
    userId: string;
    url: string;
  },
): Promise<DevSessionView> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + DEV_SESSION_TTL_MS);

  const [existing] = await master
    .select({ id: uSessions.id })
    .from(uSessions)
    .where(
      and(
        eq(uSessions.appId, params.appId),
        eq(uSessions.userId, params.userId),
        eq(uSessions.workspaceId, params.workspaceId),
      ),
    )
    .limit(1);

  if (existing) {
    const [updated] = await master
      .update(uSessions)
      .set({ url: params.url, expiresAt, updatedAt: now })
      .where(eq(uSessions.id, existing.id))
      .returning({ url: uSessions.url, expiresAt: uSessions.expiresAt });
    return { url: updated.url, expiresAt: updated.expiresAt };
  }

  const [created] = await master
    .insert(uSessions)
    .values({
      id: generateId('uads'),
      appId: params.appId,
      workspaceId: params.workspaceId,
      userId: params.userId,
      url: params.url,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ url: uSessions.url, expiresAt: uSessions.expiresAt });
  return { url: created.url, expiresAt: created.expiresAt };
}

export async function getActiveDevSession(
  master: MasterDatabase,
  params: { appId: string; workspaceId: string; userId: string },
): Promise<DevSessionView | null> {
  const now = new Date();
  const [row] = await master
    .select({ url: uSessions.url, expiresAt: uSessions.expiresAt })
    .from(uSessions)
    .where(
      and(
        eq(uSessions.appId, params.appId),
        eq(uSessions.userId, params.userId),
        eq(uSessions.workspaceId, params.workspaceId),
        gt(uSessions.expiresAt, now),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function deleteDevSession(
  master: MasterDatabase,
  params: { appId: string; workspaceId: string; userId: string },
): Promise<boolean> {
  const deleted = await master
    .delete(uSessions)
    .where(
      and(
        eq(uSessions.appId, params.appId),
        eq(uSessions.userId, params.userId),
        eq(uSessions.workspaceId, params.workspaceId),
      ),
    )
    .returning({ id: uSessions.id });
  return deleted.length > 0;
}

/** Load a non-deleted app by code (any workspace). */
export async function findActiveAppByCode(master: MasterDatabase, code: string) {
  const [row] = await master
    .select()
    .from(uApps)
    .where(and(eq(uApps.code, code), eq(uApps.isActive, true), isNull(uApps.deletedAt)))
    .limit(1);
  return row ?? null;
}
