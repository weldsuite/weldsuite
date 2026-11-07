/**
 * Builds the `AdapterContext` a call acts with. GitHub needs none of this (the
 * App's installation token is minted per call); GitLab, Bitbucket and Azure DevOps
 * act with the connection's stored OAuth or access token, refreshed first when
 * it is about to expire (`credentials.ts`), and put on the context as
 * `memberToken`. A member's own token (review and merge) is passed in instead.
 */

import type { Env } from '../../types';
import { getConnectionToken } from '../credentials';
import type { Db, MergeConnectionRow } from '../db';
import { ProviderCredentialsError } from './errors';
import type { AdapterContext } from './types';

export async function adapterContextFor(
  db: Db,
  env: Env,
  connection: MergeConnectionRow,
  memberToken?: string,
): Promise<AdapterContext> {
  if (memberToken) return { env, connection, memberToken };
  if (connection.provider === 'github') return { env, connection };
  const token = await getConnectionToken(db, env, connection);
  if (!token) {
    throw new ProviderCredentialsError(connection.provider, `The ${connection.provider} connection needs to be connected again`);
  }
  return { env, connection, memberToken: token.accessToken };
}
