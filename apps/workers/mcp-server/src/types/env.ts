import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { FlagshipBinding } from '@weldsuite/feature-flags/server';
import type { MailboxStoreObject } from '@weldsuite/mail-domain/mailbox-object';
import type { MailIndex } from '@weldsuite/mail-domain/mail-index';
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

  /** Comma-separated workspace ids that may claim reserved first-party app codes. */
  WELDSUITE_APP_PUBLISHER_WORKSPACE_IDS?: string;

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
  // hub as every other surface. Hub fans out to audit / analytics / search.
  /** Hub queue consumed by entity-events-worker (Phase 2). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;
  /** helpdesk-workflow-worker: the AssignmentRouter that hands out WeldDesk conversations (ADR DESK-005). */
  HELPDESK_WORKFLOW?: Fetcher;
  /** R2 bucket for user-app bundles (shared with app-api's STORAGE binding). */
  STORAGE?: R2Bucket;
  /** Private uploads (no public domain); read via @weldsuite/worker-kit/storage. */
  PRIVATE_STORAGE?: R2Bucket;
  /**
   * Public base URL for objects in STORAGE (no trailing slash). Used when
   * `upload_social_media` stores bytes so PostPeer can fetch the asset.
   * Falls back to the test CDN host when unset.
   */
  R2_PUBLIC_URL?: string;

  // --- WeldReach (`/v1/reach/*`) -----------------------------------------
  // The approval gate reads `WORKSPACE_CACHE` and, on a miss, master through
  // `DATABASE_URL_MASTER` (like auth); raw inbound replies come from `STORAGE`.
  // The MCP server never sends outreach email: no route and no code path here opens a mailbox login.
  /**
   * KV namespace shared with reach-api and external-api: the `appaccess:<org>:weldreach`
   * entry (60 s) is read, and written on a miss, so a suspension reaches MCP as fast
   * as it reaches the app. Unbound, every read is a miss and master answers.
   */
  WORKSPACE_CACHE?: KVNamespace;
  /**
   * D1 schedule index (reach-api's database): launching, resuming and enrolling mark
   * the workspace due (kind `reach_send`, keyed by Clerk org id) so the send sweep
   * picks it up. Always bind it: unset, nothing wakes the sweep.
   */
  SCHEDULE_INDEX?: D1Database;
  /** Cloudflare Flagship: the `weldreach-sending` kill switch `GET /v1/reach/access` reports, and (shared with the mailbox store) `resolveMailStoreMode`'s per-workspace flag. Unset: both default to their "off"/`postgres` behaviour. */
  FLAGSHIP?: FlagshipBinding;

  // --- Mailbox store (docs/plans/weldmail-mailbox-store-design.md) --------
  // Read by `@weldsuite/mail-domain/store`'s `getWorkspaceMail`
  // (`src/api/lib/mail-store-context.ts`). Unset ⇒ `resolveMailStoreMode`
  // treats every workspace as `postgres`, so these three go unread until
  // mail-api's Durable Objects are actually bound (design §8). The MCP server
  // never sends (`src/api/routes/v1/mail-sending` does not exist here), so it
  // needs no `OUTBOUND_LEDGER` binding the way external-api does.
  /** mail-api's mailbox Durable Object, bound by `script_name` (one object per mailbox, always reached through `.jurisdiction('eu')`). */
  MAILBOX_STORE?: DurableObjectNamespace<MailboxStoreObject>;
  /** mail-api's per-workspace correspondent/address index, bound by `script_name`. Optional everywhere: `recentAddresses`/`messagesByCounterparty` fall back to scanning every accessible mailbox without it. */
  MAIL_INDEX?: DurableObjectNamespace<MailIndex>;
  /** EU-jurisdiction bucket for message bodies and raw MIME (decision 7) — only read by `object`/`object-only` mode's `getMessage({ bodies: true })`. */
  MAIL_STORAGE?: R2Bucket;

  // --- WeldSocial (PostPeer publishing) ----------------------------------
  // Read by publish_social_post / schedule_social_post via
  // `@weldsuite/social-publishing`. Unset leaves those two tools answering 503
  // and changes nothing else.
  /** PostPeer API key (single WeldSuite-level key, sent as `x-access-key`). */
  POSTPEER_API_KEY?: string;
  /** Override the PostPeer REST base URL. Defaults to https://api.postpeer.dev/v1. */
  POSTPEER_BASE_URL?: string;
  /** BYOK OAuth apps as JSON: platform → PostPeer app id. */
  POSTPEER_APP_IDS?: string;
}
