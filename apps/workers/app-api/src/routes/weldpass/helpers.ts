/**
 * Shared plumbing for the WeldPass routes: resolving the addressed vault, and
 * translating service errors into the standard response envelope.
 */

import type { Context } from 'hono';
import { error } from '../../lib/response';
import { EnvelopeError, rootKeyringFromEnv, type RootKeyring } from '../../services/weldpass/envelope';
import { ProviderError } from '../../services/weldpass/providers';
import { SecretKeyError } from '../../services/weldpass/secrets';
import {
  VaultNotFoundError,
  openVault,
  requireEnvironment,
  type VaultProject,
} from '../../services/weldpass/vault';
import type { Database } from '../../db';
import type { Env, Variables } from '../../types';

type WeldPassContext = Context<{ Bindings: Env; Variables: Variables }>;

export function keyring(c: WeldPassContext): RootKeyring {
  return rootKeyringFromEnv(c.env);
}

/**
 * Read a path parameter the route is known to declare.
 *
 * These helpers take a context without a path literal, so Hono types every
 * parameter as possibly missing. The check is kept real rather than cast away,
 * so renaming a route segment fails loudly instead of passing `undefined` into
 * a lookup.
 */
function pathParam(c: WeldPassContext, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new Error(`WeldPass route is missing the :${name} parameter`);
  return value;
}

/** Project + unwrapped KEK for the `:projectId` in the path. */
export async function vaultFor(c: WeldPassContext): Promise<{
  db: Database;
  workspaceId: string;
  project: VaultProject;
  kek: Uint8Array<ArrayBuffer>;
}> {
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  const { project, kek } = await openVault(db, workspaceId, keyring(c), pathParam(c, 'projectId'));
  return { db, workspaceId, project, kek };
}

/** As `vaultFor`, plus the `:environmentId` verified to belong to that project. */
export async function environmentFor(c: WeldPassContext) {
  const vault = await vaultFor(c);
  const environment = await requireEnvironment(
    vault.db,
    vault.project.id,
    pathParam(c, 'environmentId'),
  );
  return { ...vault, environment };
}

/**
 * Translate the errors the WeldPass services throw. Called from the WeldPass
 * router-s own `onError` boundary.
 * Returns `null` for anything that is not a WeldPass error.
 */
export function toWeldPassErrorResponse(err: unknown, c: WeldPassContext): Response | null {
  if (err instanceof VaultNotFoundError) {
    return error.notFound(c, err.resource, err.id);
  }

  if (err instanceof SecretKeyError) {
    return error.badRequest(c, err.message);
  }

  if (err instanceof ProviderError) {
    return c.json({ error: { code: 'SYNC_FAILED', message: err.message } }, 502);
  }

  if (err instanceof EnvelopeError) {
    // A vault that will not open is an operational incident (missing or rotated
    // root key), not something the caller can fix — so it is logged in full and
    // answered with a generic message.
    console.error('[weldpass] envelope failure:', err.message);
    return c.json(
      {
        error: {
          code: 'CRYPTO_ERROR',
          message:
            'This vault could not be opened. Its encryption key is unavailable — contact an administrator.',
        },
      },
      500,
    );
  }

  return null;
}
