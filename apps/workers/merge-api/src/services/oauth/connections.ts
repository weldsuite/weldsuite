/**
 * Workspace connections made with OAuth (GitLab.com, Bitbucket Cloud, Azure
 * DevOps) or a token (self-managed GitLab). The credentials are stored sealed
 * on the connection (`credentials`, `credentials_expire_at`); the authorizing
 * member's login is `oauth_user_login`. Re-authorizing the same account
 * refreshes the existing connection instead of adding another.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { generateId } from '@weldsuite/worker-kit/id';
import { isUniqueViolation } from '@weldsuite/worker-kit/pg-errors';
import type { MergeProvider } from '@weldsuite/app-api-client/schemas/weldmerge';
import type { MergeStoredCredentials } from '@weldsuite/app-api-client/schemas/weldmerge-providers';
import type { Env } from '../../types';
import { getConnectionToken, sealCredentials } from '../credentials';
import { mergeConnections, type Db, type MergeConnectionRow } from '../db';
import { bearer, isStatus, sendRequest } from '../providers/provider-http';

export interface OAuthConnectionInput {
  provider: MergeProvider;
  userId: string;
  externalAccountId: string;
  accountLogin: string | null;
  accountType: string | null;
  /** Self-managed GitLab base URL, Azure DevOps organisation URL; null otherwise. */
  host: string | null;
  /** The login of the member who authorized it. */
  oauthUserLogin: string | null;
  credentials: MergeStoredCredentials;
  /** `needs_attention` while an Azure DevOps connection has no organisation yet. */
  status?: 'active' | 'needs_attention';
}

const liveRow = (provider: MergeProvider, externalAccountId: string) =>
  and(
    eq(mergeConnections.provider, provider),
    eq(mergeConnections.externalAccountId, externalAccountId),
    isNull(mergeConnections.deletedAt),
  );

async function findLive(db: Db, provider: MergeProvider, externalAccountId: string): Promise<MergeConnectionRow | null> {
  const [row] = await db.select().from(mergeConnections).where(liveRow(provider, externalAccountId)).limit(1);
  return row ?? null;
}

/** Creates the connection, or renews the stored credentials of the one for the same account. */
export async function upsertOAuthConnection(
  db: Db,
  env: Env,
  input: OAuthConnectionInput,
): Promise<{ connection: MergeConnectionRow; created: boolean }> {
  const now = new Date();
  const fields = {
    accountLogin: input.accountLogin,
    accountType: input.accountType,
    host: input.host,
    status: input.status ?? 'active',
    credentials: await sealCredentials(env, input.credentials),
    credentialsExpireAt: input.credentials.expiresAt ? new Date(input.credentials.expiresAt) : null,
    oauthUserLogin: input.oauthUserLogin,
    revokedAt: null,
    updatedAt: now,
  } as const;

  const renew = async (existing: MergeConnectionRow) => {
    const [row] = await db.update(mergeConnections).set(fields).where(eq(mergeConnections.id, existing.id)).returning();
    return { connection: row!, created: false };
  };

  const existing = await findLive(db, input.provider, input.externalAccountId);
  if (existing) return renew(existing);
  try {
    const [row] = await db
      .insert(mergeConnections)
      .values({
        id: generateId('mcn'),
        provider: input.provider,
        externalAccountId: input.externalAccountId,
        createdByUserId: input.userId,
        installedAt: now,
        createdAt: now,
        ...fields,
      })
      .returning();
    return { connection: row!, created: true };
  } catch (err) {
    // Two members connected the same account at once: the other insert won.
    if (!isUniqueViolation(err)) throw err;
    const winner = await findLive(db, input.provider, input.externalAccountId);
    if (!winner) throw err;
    return renew(winner);
  }
}

export type SetOrganizationResult =
  | { ok: true; connection: MergeConnectionRow }
  | { ok: false; reason: 'not_found' | 'organization_not_accessible' | 'organization_taken' };

/**
 * Chooses the Azure DevOps organisation a connection works in. The member's token
 * must reach it (`GET {org}/_apis/projects?$top=1`); the connection's
 * `external_account_id` becomes the organisation name and `host` its URL.
 */
export async function setAzureOrganization(
  db: Db,
  env: Env,
  connection: MergeConnectionRow,
  organization: string,
): Promise<SetOrganizationResult> {
  const name = organization.trim();
  const url = `https://dev.azure.com/${encodeURIComponent(name)}`;
  const token = await getConnectionToken(db, env, connection);
  if (!token) return { ok: false, reason: 'organization_not_accessible' };
  try {
    await sendRequest('azure_devops', { method: 'GET', url: `${url}/_apis/projects?$top=1&api-version=7.1`, headers: bearer(token.accessToken) });
  } catch (err) {
    if (isStatus(err, 401, 403, 404)) return { ok: false, reason: 'organization_not_accessible' };
    throw err;
  }
  const clash = await findLive(db, 'azure_devops', name);
  if (clash && clash.id !== connection.id) return { ok: false, reason: 'organization_taken' };
  try {
    const [row] = await db
      .update(mergeConnections)
      .set({ externalAccountId: name, accountLogin: name, accountType: 'organization', host: url, status: 'active', updatedAt: new Date() })
      .where(eq(mergeConnections.id, connection.id))
      .returning();
    return { ok: true, connection: row! };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: 'organization_taken' };
    throw err;
  }
}
