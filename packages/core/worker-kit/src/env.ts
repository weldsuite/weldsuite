/**
 * Bindings and context variables every API worker shares.
 *
 * A worker's own `Env` extends `KitEnv` with only the bindings and secrets
 * that module uses, and its `Variables` extend `KitVariables`.
 */

import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import type * as schema from '@weldsuite/db/schema';
import type { ResolvedPermissions } from '@weldsuite/permissions/types';
import type { FlagContext, FlagshipBinding } from '@weldsuite/feature-flags/server';

export type Database = NeonHttpDatabase<typeof schema>;

/** What tenant DB resolution needs (master DB + KV cache + Neon). */
export interface DbEnv {
  DATABASE_URL_MASTER: string;
  WORKSPACE_CACHE: KVNamespace;
  NEON_API_KEY: string;
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;
}

export interface KitEnv extends DbEnv {
  ENVIRONMENT: string;
  CLERK_SECRET_KEY: string;
  /**
   * PEM public key for networkless Clerk token verification. Set it on every
   * API worker: without it each cold isolate fetches Clerk's JWKS.
   */
  CLERK_JWT_KEY?: string;
  /**
   * "true" enforces per-app permission checks (a key refused in the request's
   * X-Weld-App app is a 403 even when another app grants it); anything else
   * only logs those refusals (@weldsuite/permissions app-scope). Every API
   * worker checks permissions, so switch it on in ALL of them together —
   * app-api alone would leave the module workers in log-only mode.
   */
  PERMISSIONS_APP_ENFORCE?: string;
  /** Test-only seam for `X-Test-Flags` (never set in production). */
  TEST_FIXTURES_TOKEN?: string;
  FLAGSHIP?: FlagshipBinding;
}

export type KitVariables = {
  requestId: string;
  userId: string;
  orgId: string | null;
  sessionId: string;
  tenantDb: Database;
  workspaceId: string;
  /** Apps the workspace is licensed for; null = unrestricted (workspaceDbMiddleware). */
  licensedApps?: readonly string[] | null;
  /** Partner suspended or licence inactive: writes are refused (licenceGate). */
  readOnly?: boolean;
  readOnlyReason?: 'partner_suspended' | 'licence_inactive' | null;
  userPermissions?: ResolvedPermissions;
  /** Canonical app code from the X-Weld-App header (appContextMiddleware). */
  app?: string;
  flags?: FlagContext;
  /**
   * Set only by a worker's named `WorkerEntrypoint` (`<Name>Internal`), which is
   * reachable over a service binding and nothing else, so the request is
   * trusted by topology. Internal-route secret checks accept it in place of
   * the `INTERNAL_API_SECRET` bearer; the public paths never set it.
   */
  internalTrusted?: boolean;
};
