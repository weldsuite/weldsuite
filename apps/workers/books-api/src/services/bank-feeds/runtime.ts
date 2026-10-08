/**
 * Wiring for the routes: provider config from the worker's secrets, the
 * master index, the encryption keyring and the existing reconciliation matcher.
 */

import type { Context } from 'hono';
import { bankFeedConfigFromEnv, createBankFeedProvider, type BankFeedProvider } from '@weldsuite/bank-feeds';
import { keyringFromEnv } from '@weldsuite/db/lib/crypto';
import { getMasterDb, getWorkspaceContextForOrg, schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';
import { autoReconcileBatch } from '../accounting-reconciliation';
import { masterBankFeedIndex } from './master-index';
import type { BankFeedIndex, FeedContext } from './types';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

/** The providers this worker has credentials for. */
export function feedProviders(env: Env) {
  const config = bankFeedConfigFromEnv(env, {
    pontoFetch: env.PONTO_CERT ? (input, init) => (env.PONTO_CERT as Fetcher).fetch(input, init as RequestInit) : undefined,
  });
  const cache = new Map<string, BankFeedProvider>();
  return {
    config,
    get(id: string): BankFeedProvider {
      const cached = cache.get(id);
      if (cached) return cached;
      const provider = createBankFeedProvider(id, config);
      cache.set(id, provider);
      return provider;
    },
  };
}

function lazyIndex(env: Env): BankFeedIndex {
  let index: BankFeedIndex | null = null;
  const real = () => (index ??= masterBankFeedIndex(getMasterDb(env)));
  return {
    upsert: (rows) => real().upsert(rows),
    setActive: (id, active, lastError) => real().setActive(id, active, lastError),
    remove: (id) => real().remove(id),
  };
}

export function buildFeedContext(env: Env, db: Database, clerkOrgId: string): FeedContext {
  const providers = feedProviders(env);
  return {
    db,
    keyring: keyringFromEnv(env),
    index: lazyIndex(env),
    getProvider: (id) => providers.get(id),
    clerkOrgId,
    autoReconcile: async (handle, bankAccountId) => (await autoReconcileBatch(handle, schema, bankAccountId, null)).reconciledCount,
  };
}

/** Feed context for a Clerk-authed request. */
export function createFeedContext(c: AppContext): FeedContext {
  return buildFeedContext(c.env, c.get('tenantDb'), c.get('orgId') ?? '');
}

/**
 * Feed context for a call on the `BooksInternal` entrypoint: the tenant comes
 * from `X-Workspace-Id` (Clerk org id) and is set on the request context so
 * entity events carry the workspace. Null when the header is missing or the
 * workspace is unknown or suspended.
 */
export async function createInternalFeedContext(c: AppContext): Promise<FeedContext | null> {
  const orgId = c.req.header('X-Workspace-Id');
  if (!orgId) return null;
  try {
    const workspace = await getWorkspaceContextForOrg(c.env, orgId);
    if (workspace.suspended) return null;
    c.set('tenantDb', workspace.db);
    c.set('workspaceId', workspace.id);
    c.set('orgId', orgId);
    c.set('userId', 'system');
    return buildFeedContext(c.env, workspace.db, orgId);
  } catch (err) {
    console.error('[bank-feeds/internal] tenant resolution failed:', err instanceof Error ? err.message : err);
    return null;
  }
}
