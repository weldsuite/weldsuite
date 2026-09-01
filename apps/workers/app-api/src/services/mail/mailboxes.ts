/**
 * Cross-workspace mailbox directory — master memberships + per-tenant
 * mail-account lists. Used by WeldMail so a user who belongs to several
 * workspaces (and/or a personal inbox) can see every mailbox in one sidebar
 * without flipping the Clerk active org first.
 *
 * Each workspace DB is opened independently; a failure in one tenant must
 * not hide the others.
 */

import { listUserWorkspaces, type WorkspaceSummary } from '../workspaces';
import { listMailAccounts } from './accounts';
import { getMasterDb, getWorkspaceContextForOrg, type MasterDatabase } from '../../db';
import type { Env } from '../../types';

export interface MailboxAccount {
  id: string;
  email: string;
  displayName: string;
  provider: string | null;
  isDefault: boolean;
  status: string;
}

export interface WorkspaceMailboxGroup {
  clerkOrgId: string;
  workspaceId: string;
  workspaceName: string;
  slug: string;
  imageUrl: string | null;
  role: string;
  accounts: MailboxAccount[];
}

async function accountsForWorkspace(
  env: Env,
  userId: string,
  ws: WorkspaceSummary,
): Promise<MailboxAccount[]> {
  try {
    const { db, suspended } = await getWorkspaceContextForOrg(env, ws.id);
    if (suspended) return [];
    const { data } = await listMailAccounts(db, userId, { limit: 100 });
    return data.map((row) => ({
      id: row.id,
      email: row.email,
      displayName: row.displayName ?? row.name ?? row.email,
      provider: row.provider ?? null,
      isDefault: !!row.isDefault,
      status: row.status,
    }));
  } catch (err) {
    console.error('[mailboxes] failed to list accounts for', ws.id, err);
    return [];
  }
}

/** List every workspace the user belongs to, with the mail accounts they can see. */
export async function listUserMailboxes(
  env: Env,
  userId: string,
  masterDb: MasterDatabase = getMasterDb(env),
): Promise<WorkspaceMailboxGroup[]> {
  const workspaces = await listUserWorkspaces(masterDb, userId);
  const groups = await Promise.all(
    workspaces.map(async (ws) => ({
      clerkOrgId: ws.id,
      workspaceId: ws.workspaceId,
      workspaceName: ws.name,
      slug: ws.slug,
      imageUrl: ws.imageUrl,
      role: ws.role,
      accounts: await accountsForWorkspace(env, userId, ws),
    })),
  );
  return groups;
}
