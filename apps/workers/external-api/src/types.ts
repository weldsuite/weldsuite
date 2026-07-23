import type { TenantTier } from '@weldsuite/db/schema/master';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { Database } from './db';

/**
 * Cloudflare Workers environment bindings for external-api.
 */
export interface Env {
  /** Hyperdrive binding for the master Postgres (registry + workspace lookups). */
  HYPERDRIVE_MASTER: Hyperdrive;
  /** KV namespace: API-key registry + workspace metadata cache (5-min TTL). */
  API_CACHE: KVNamespace;
  // --- Native rate-limit bindings (one namespace per tier) ----------------
  // Keyed per workspace in `rateLimitMiddleware`. Limits live in wrangler.toml
  // (`[ratelimits.simple]`); per-location + eventually consistent by design.
  /** Free tier: 60 req/min. */
  RL_FREE: RateLimit;
  /** Business tier: 300 req/min. */
  RL_BUSINESS: RateLimit;
  /** Scale tier: 1,000 req/min. */
  RL_SCALE: RateLimit;
  /** Enterprise tier: 5,000 req/min. */
  RL_ENTERPRISE: RateLimit;
  /** Environment slug — informational. */
  ENVIRONMENT: 'test' | 'preview' | 'production';
  /** Reserved for future request-signing. */
  API_SIGNING_SECRET?: string;
  /** Neon API key — used by master-DB lookups to resolve workspace connection URLs. */
  NEON_API_KEY: string;
  /** Optional key for decrypting the stored databaseUrl on master workspaces. */
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;

  // --- Entity-event publishing -------------------------------------------
  // Fed by `publishEntityEvent` so mutations through the public API reach the
  // same audit / workflow / analytics / realtime sinks as app-api. Each sink
  // is optional — a missing binding logs a warning and the rest still fire.
  /** Audit-log queue consumer. */
  AUDIT_EVENTS?: Queue<EntityEventMessage>;
  /** Workflow-event queue consumer. */
  WORKFLOW_EVENTS?: Queue<EntityEventMessage>;
  /** Analytics queue consumer. */
  ANALYTICS_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;
  /** R2 bucket for user-app bundles (shared with app-api's STORAGE binding). */
  STORAGE?: R2Bucket;
}

/**
 * Validated API-key session set by auth middleware.
 */
export interface ApiKeySession {
  /** Unique identifier for the API key (the token id for app tokens). */
  keyId: string;
  /**
   * Personal keys belong to a user; workspace keys are shared; `app` sessions
   * come from user-app tokens (`wsat_`) minted against an install grant.
   */
  keyType: 'personal' | 'workspace' | 'app';
  /** Workspace this key grants access to. */
  workspaceId: string;
  /** User ID for personal keys, null for workspace and app keys. */
  userId: string | null;
  /** Permission scopes granted to this key. */
  scopes: string[];
  /** Workspace plan tier (free, business, scale, enterprise). */
  tier: TenantTier;
  /** Whether the workspace plan has API access. */
  hasApiAccess: boolean;
  /** Workspace-specific database URL (resolved from master DB). */
  databaseUrl: string | null;
  /** User-app id — set only for `app` sessions. */
  appId?: string;
  /** User-app code (sidenav/app-store code) — set only for `app` sessions. */
  appCode?: string;
  /** Install grant id backing the token — set only for `app` sessions. */
  installId?: string;
}

/**
 * Hono context variables set across middleware.
 */
export type Variables = {
  /** API session set by `authMiddleware`. */
  apiSession: ApiKeySession;
  /** Per-request tenant Drizzle client set by `tenantDbMiddleware`. */
  tenantDb: Database;
  /** Workspace id mirrored from `apiSession` for `publishEntityEvent`. */
  workspaceId: string;
  /**
   * Actor id for entity events. For personal keys this is the user id; for
   * workspace keys (which have no user) it falls back to the API key id so
   * audit/workflow events still carry a stable actor.
   */
  userId: string;
};

export type HonoEnv = { Bindings: Env; Variables: Variables };

declare module 'hono' {
  interface ContextVariableMap extends Variables {}
}
