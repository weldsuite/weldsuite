/**
 * Integration resolution — the provider-agnostic seam every integration-backed
 * action goes through to fetch a workspace's configured integration and its
 * (decrypted) credentials.
 */

import { eq, and, isNull } from 'drizzle-orm';
import { schema } from '../db';
import type {
  WorkflowDb,
  ResolvedIntegration,
  ResolveIntegrationParams,
  ResolveIntegrationOptions,
} from './types';
import { IntegrationNotFoundError, IntegrationNotConnectedError } from './errors';

export async function resolveIntegration(
  db: WorkflowDb,
  params: ResolveIntegrationParams,
  opts: ResolveIntegrationOptions = {},
): Promise<ResolvedIntegration> {
  const table = schema.workflowIntegrations;
  const selector = params.integrationId
    ? `id=${params.integrationId}`
    : `type=${params.type ?? ''}`;

  const where = params.integrationId
    ? and(eq(table.id, params.integrationId), isNull(table.deletedAt))
    : and(eq(table.type, String(params.type ?? '')), isNull(table.deletedAt));

  const [row] = await db.select().from(table).where(where).limit(1);
  if (!row) throw new IntegrationNotFoundError(selector);
  if (row.status !== 'connected') throw new IntegrationNotConnectedError(selector, row.status);

  const rawCredentials = (row.credentials ?? {}) as Record<string, unknown>;
  const credentials = opts.decrypt ? await opts.decrypt(rawCredentials) : rawCredentials;

  return {
    id: row.id,
    type: row.type,
    status: row.status,
    credentials,
    oauthTokens: (row.oauthTokens ?? undefined) as ResolvedIntegration['oauthTokens'],
    settings: (row.settings ?? undefined) as Record<string, unknown> | undefined,
  };
}

/** Extract the usable bearer token from a resolved integration, if any. */
export function integrationBearerToken(integ: ResolvedIntegration): string | undefined {
  const fromOauth = integ.oauthTokens?.accessToken;
  const creds = integ.credentials || {};
  const fromCreds =
    (creds.accessToken as string | undefined) ??
    (creds.botToken as string | undefined) ??
    (creds.apiKey as string | undefined) ??
    (creds.token as string | undefined);
  return fromOauth ?? fromCreds;
}
