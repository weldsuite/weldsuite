/**
 * The OAuth callback: what happens after the provider sent the member back to
 * `/weldmerge/oauth/callback` with a `code` and our `state`. The state is
 * consumed (single use) and must belong to the caller; the code is exchanged,
 * the provider says whose token it is, and the credentials are stored: on a new
 * or renewed workspace connection (`purpose = connection`) or on the member's
 * own account (`purpose = account`).
 *
 * Azure DevOps connections also need an organisation: with exactly one the
 * connection takes it, with several it stays `needs_attention` until the member
 * picks one (`POST /connections/azure_devops/organization`).
 */

import type {
  MergeAzureOrganizationOption,
  MergeOauthCallbackResult,
  MergeOauthState,
  MergeStoredCredentials,
} from '@weldsuite/app-api-client/schemas/weldmerge-providers';
import type { Env } from '../../types';
import type { Db, MergeConnectionRow } from '../db';
import { listAzureOrganizations } from '../providers/azure-devops/oauth';
import { oauthFor } from '../providers/registry';
import type { OAuthUser } from '../providers/types';
import { linkProviderAccount } from './accounts';
import { upsertOAuthConnection } from './connections';
import { redirectUriOf } from './authorize';
import { consumeOAuthState } from './state';

export type CallbackFailure = 'invalid_state' | 'state_mismatch' | 'forbidden' | 'login_taken' | 'no_organizations';

export type CallbackOutcome =
  | { ok: true; result: MergeOauthCallbackResult; connection: MergeConnectionRow | null; created: boolean }
  | { ok: false; reason: CallbackFailure };

interface CallbackInput {
  code: string;
  state: string;
  userId: string;
  workspaceId: string;
  /** Whether the caller holds merge_connections:manage (a workspace connection needs it; a member account does not). */
  canConnect: boolean;
}

/** A connection from a GitLab or Bitbucket sign-in: the account that authorized it. */
function accountConnection(user: OAuthUser) {
  return {
    externalAccountId: user.externalId,
    accountLogin: user.login,
    accountType: 'user',
    host: null,
  };
}

async function connectAzure(
  db: Db,
  env: Env,
  state: MergeOauthState,
  userId: string,
  user: OAuthUser,
  credentials: MergeStoredCredentials,
): Promise<CallbackOutcome> {
  const organizations = await listAzureOrganizations(credentials.accessToken, user.externalId);
  if (organizations.length === 0) return { ok: false, reason: 'no_organizations' };
  const only = organizations.length === 1 ? organizations[0]! : null;
  const { connection, created } = await upsertOAuthConnection(db, env, {
    provider: 'azure_devops',
    userId,
    externalAccountId: only ? only.name : `pending:${user.externalId}`,
    accountLogin: only ? only.name : user.login,
    accountType: only ? 'organization' : 'user',
    host: only ? only.url : null,
    oauthUserLogin: user.login,
    credentials,
    status: only ? 'active' : 'needs_attention',
  });
  const options: MergeAzureOrganizationOption[] | undefined = only ? undefined : organizations;
  return {
    ok: true,
    connection,
    created,
    result: {
      purpose: state.purpose,
      provider: 'azure_devops',
      returnTo: state.returnTo ?? null,
      connectionId: connection.id,
      accountId: null,
      ...(options ? { organizations: options } : {}),
    },
  };
}

async function connect(
  db: Db,
  env: Env,
  state: MergeOauthState,
  userId: string,
  user: OAuthUser,
  credentials: MergeStoredCredentials,
): Promise<CallbackOutcome> {
  if (state.provider === 'azure_devops') return connectAzure(db, env, state, userId, user, credentials);
  if (state.provider !== 'gitlab' && state.provider !== 'bitbucket') return { ok: false, reason: 'invalid_state' };
  const { connection, created } = await upsertOAuthConnection(db, env, {
    provider: state.provider,
    userId,
    ...accountConnection(user),
    oauthUserLogin: user.login,
    credentials,
  });
  return {
    ok: true,
    connection,
    created,
    result: {
      purpose: state.purpose,
      provider: state.provider,
      returnTo: state.returnTo ?? null,
      connectionId: connection.id,
      accountId: null,
    },
  };
}

async function link(
  db: Db,
  env: Env,
  state: MergeOauthState,
  userId: string,
  user: OAuthUser,
  credentials: MergeStoredCredentials,
): Promise<CallbackOutcome> {
  const linked = await linkProviderAccount(db, env, { userId, provider: state.provider, host: null, user, credentials });
  if (!linked.ok) return linked;
  return {
    ok: true,
    connection: null,
    created: false,
    result: {
      purpose: state.purpose,
      provider: state.provider,
      returnTo: state.returnTo ?? null,
      connectionId: null,
      accountId: linked.account.id,
    },
  };
}

export async function completeOAuth(db: Db, env: Env, input: CallbackInput): Promise<CallbackOutcome> {
  const state = await consumeOAuthState(env.WORKSPACE_CACHE, input.state);
  if (!state) return { ok: false, reason: 'invalid_state' };
  if (state.userId !== input.userId || state.workspaceId !== input.workspaceId) return { ok: false, reason: 'state_mismatch' };
  if (state.purpose === 'connection' && !input.canConnect) return { ok: false, reason: 'forbidden' };

  const oauth = oauthFor(state.provider);
  const credentials = await oauth.exchangeCode(env, { code: input.code, redirectUri: redirectUriOf(env), host: null });
  const user = await oauth.currentUser(env, { accessToken: credentials.accessToken, host: null });
  return state.purpose === 'account'
    ? link(db, env, state, input.userId, user, credentials)
    : connect(db, env, state, input.userId, user, credentials);
}
