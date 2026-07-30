import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { RateLimiter } from '../durable-objects/rate-limiter';

/**
 * Cloudflare Workers environment bindings for MCP server.
 *
 * The MCP server is self-contained: it owns its copy of the v1 resource routes
 * (`src/api/`) and talks to the tenant database directly, so it needs the same
 * data-plane bindings a resource API does. No request path depends on another
 * worker. The one cross-worker binding this type permits is the optional
 * `REALTIME` fan-out below; it is not bound in wrangler.toml today, and
 * `publishEntityEvent` no-ops without it.
 */
export interface Env {
  // Neon connection string for master DB (set via wrangler secret).
  // Used to resolve a Clerk organization to its workspace, plan tier and
  // tenant database URL.
  DATABASE_URL_MASTER: string;

  // Hyperdrive binding for the master Postgres, used by the ported WeldApps
  // routes (`src/api/routes/v1/user-apps.ts`, `app-storage.ts`) which read the
  // cross-workspace app tables. Kept as a separate binding so those routes stay
  // byte-identical to their external-api origin.
  HYPERDRIVE_MASTER: Hyperdrive;

  // KV namespace for caching workspace lookups.
  // Shared with app-api/external-api for cache coherence.
  API_CACHE: KVNamespace;

  // Durable Objects for distributed per-workspace rate limiting
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;

  // Environment
  ENVIRONMENT: 'test' | 'preview' | 'production';

  // Public origin this worker is served on (e.g. https://mcp.weldsuite.org).
  // Used to build the RFC 9728 protected-resource metadata `resource` value,
  // which MUST match the URL clients used to reach the MCP endpoint.
  MCP_SERVER_URL: string;

  // Clerk — the OAuth authorization server backing MCP authentication.
  CLERK_PUBLISHABLE_KEY: string;
  CLERK_SECRET_KEY: string;
  // Optional PEM public key; when set, JWT verification is networkless.
  CLERK_JWT_KEY?: string;

  // Neon API key — resolves a workspace's tenant connection URL.
  NEON_API_KEY: string;
  // Optional keys for decrypting the stored databaseUrl on master workspaces.
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;

  // --- Entity-event publishing -------------------------------------------
  // Fed by `publishEntityEvent` so mutations made through MCP reach the same
  // audit / workflow / analytics / realtime sinks as every other surface. Each
  // sink is optional — a missing binding logs a warning and the rest still fire.
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
