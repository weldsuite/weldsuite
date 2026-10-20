/**
 * Per-developer preview sessions for `weld app dev`.
 *
 * The URL allowlist lives in `@weldsuite/app-api-client/schemas/user-apps`
 * (shared with external-api). This module owns the master-DB upsert and the
 * rule for who gets a session back.
 *
 * A preview session makes the platform load developer-chosen code (a localhost
 * or tunnel URL) in the member's own session, so it is only ever shown to the
 * developer it belongs to: the row's user, in the authoring workspace of the
 * app, holding `weldapps:develop`. See `resolveViewerDevSession`.
 */

import { and, eq, gt, isNull } from 'drizzle-orm';
import { DEV_SESSION_TTL_MS, isAllowedDevSessionUrl } from '@weldsuite/app-api-client/schemas/user-apps';
import { masterSchema, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

export { DEV_SESSION_TTL_MS, isAllowedDevSessionUrl };

const uSessions = masterSchema.userAppDevSessions;
const uApps = masterSchema.userApps;

export interface DevSessionView {
  url: string;
  /**
   * The exact origin registered for the session. The platform pins the preview
   * frame and its bridge to this origin; tunnel hosts are never matched by
   * wildcard on the client.
   */
  origin: string;
  expiresAt: Date;
}

/** `origin` of a registered URL; null when the stored value is not a usable preview URL. */
function registeredOrigin(url: string): string | null {
  if (!isAllowedDevSessionUrl(url)) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function toView(row: { url: string; expiresAt: Date }): DevSessionView | null {
  const origin = registeredOrigin(row.url);
  return origin ? { url: row.url, origin, expiresAt: row.expiresAt } : null;
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

  let row: { url: string; expiresAt: Date } | undefined;
  if (existing) {
    [row] = await master
      .update(uSessions)
      .set({ url: params.url, expiresAt, updatedAt: now })
      .where(eq(uSessions.id, existing.id))
      .returning({ url: uSessions.url, expiresAt: uSessions.expiresAt });
  } else {
    [row] = await master
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
  }
  const view = row ? toView(row) : null;
  if (!view) throw new Error('Preview session was stored with a URL that is not an allowed preview URL');
  return view;
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
  // A row written before the allowlist tightened (or by another surface) is
  // re-checked here, so the platform never receives a URL it should not load.
  return row ? toView(row) : null;
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

/**
 * The preview session the platform may show `userId` for app `code`, or null.
 *
 * Enforced here, not in the UI:
 *   - only the developer the session belongs to (the row is keyed by the
 *     caller's own user id; nobody can read another user's session);
 *   - only for an app owned by the caller's workspace (a preview is the
 *     authoring workspace's own code, never another workspace's app);
 *   - only for a caller allowed to develop apps (`weldapps:develop`), so a
 *     member who merely uses the app never receives a preview URL, whatever a
 *     workspace API key registered on their behalf;
 *   - only while the registered URL is still an allowed preview URL.
 */
export async function resolveViewerDevSession(
  master: MasterDatabase,
  params: { code: string; workspaceId: string; userId: string; canDevelop: boolean },
): Promise<DevSessionView | null> {
  if (!params.canDevelop) return null;
  const appRow = await findActiveAppByCode(master, params.code);
  if (appRow?.ownerWorkspaceId !== params.workspaceId) return null;
  return getActiveDevSession(master, {
    appId: appRow.id,
    workspaceId: params.workspaceId,
    userId: params.userId,
  });
}
