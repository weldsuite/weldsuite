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
  // same hub as app-api. Hub fans out to audit / analytics / search.
  /** Hub queue consumed by entity-events-worker (Phase 2). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;
  /**
   * R2 bucket shared with app-api's STORAGE binding: user-app bundles, and
   * WeldMail attachments (downloads, API uploads, sent copies).
   */
  STORAGE?: R2Bucket;
  /** Public hostname that serves STORAGE objects (contact avatars made on send). */
  R2_PUBLIC_URL?: string;

  // --- WeldMail sending (`/v1/mail-*` send routes) -------------------------
  // Read by `@weldsuite/mail-domain/send`. Unset SEND_EMAIL leaves the send
  // routes answering 503 and changes nothing else.
  /** Cloudflare `[[send_email]]` binding for outbound mail (same as mail-api's). */
  SEND_EMAIL?: SendEmail;
  /** KV cache for recipient MX lookups (mail-api's namespace, so the cache is shared). */
  WORKSPACE_CACHE?: KVNamespace;
  /**
   * Comma-separated master workspace ids whose WeldApps are first-party.
   * Those apps skip public review and show an Official badge in the store.
   */
  WELDSUITE_APP_PUBLISHER_WORKSPACE_IDS?: string;

  // --- WeldSocial (PostPeer publishing) ----------------------------------
  // Read by the social publish/schedule routes via `@weldsuite/social-publishing`.
  // Unset leaves those routes answering 503 and changes nothing else.
  /** PostPeer API key (single WeldSuite-level key, sent as `x-access-key`). */
  POSTPEER_API_KEY?: string;
  /** Override the PostPeer REST base URL. Defaults to https://api.postpeer.dev/v1. */
  POSTPEER_BASE_URL?: string;
  /** BYOK OAuth apps as JSON: platform → PostPeer app id. */
  POSTPEER_APP_IDS?: string;
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
  /**
   * Apps the workspace is licensed for (partner-managed workspaces), or null
   * when unrestricted. Checked per request by licenceMiddleware.
   */
  licensedApps: readonly string[] | null;
  /**
   * True when the workspace is read-only (partner suspended or licence
   * inactive): licenceMiddleware refuses writes with 403 WORKSPACE_READ_ONLY.
   * Absent = writable.
   */
  readOnly?: boolean;
  readOnlyReason?: 'partner_suspended' | 'licence_inactive' | null;
  /**
   * The workspace's Clerk org id, which R2 keys and the shared mail/social
   * packages key on (unlike `workspaceId`, the master `workspaces.id`).
   * Undefined when the workspace came from an older cache entry; resolve it with
   * `resolveClerkOrgId` then.
   */
  clerkOrgId?: string | null;
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
