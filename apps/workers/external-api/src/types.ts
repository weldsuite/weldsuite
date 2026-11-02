import type { TenantTier } from '@weldsuite/db/schema/master';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { FlagshipBinding } from '@weldsuite/feature-flags/server';
import type { OutboundGuardEnv } from '@weldsuite/mail-domain/outbound';
import type { MailboxStoreObject } from '@weldsuite/mail-domain/mailbox-object';
import type { MailIndex } from '@weldsuite/mail-domain/mail-index';
import type { AppAccess } from '@weldsuite/worker-kit/app-access';
import type { Database } from './db';

/**
 * Cloudflare Workers environment bindings for external-api.
 */
export interface Env extends Pick<OutboundGuardEnv, 'OUTBOUND_LEDGER' | 'OUTBOUND_PLATFORM' | 'OUTBOUND_BACKSTOP'> {
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
  /** helpdesk-workflow-worker: the AssignmentRouter that hands out WeldDesk conversations (ADR DESK-005). */
  HELPDESK_WORKFLOW?: Fetcher;
  /**
   * R2 bucket shared with app-api's STORAGE binding: user-app bundles, and
   * WeldMail attachments (downloads, API uploads, sent copies).
   */
  STORAGE?: R2Bucket;
  /** Private uploads (no public domain); read via @weldsuite/worker-kit/storage. */
  PRIVATE_STORAGE?: R2Bucket;
  /** Public hostname that serves STORAGE objects (contact avatars made on send). */
  R2_PUBLIC_URL?: string;

  // --- WeldMail sending (`/v1/mail-*` send routes) -------------------------
  // Read by `@weldsuite/mail-domain/send`. Unset SEND_EMAIL leaves the send
  // routes answering 503 and changes nothing else.
  /** Cloudflare `[[send_email]]` binding for outbound mail (same as mail-api's). */
  SEND_EMAIL?: SendEmail;
  /** KV cache for recipient MX lookups (mail-api's namespace, so the cache is shared). Also the mailbox directory cache in `object`/`object-only` mode (design §6). */
  WORKSPACE_CACHE?: KVNamespace;

  // --- Mailbox store (docs/plans/weldmail-mailbox-store-design.md) --------
  // Read by `@weldsuite/mail-domain/store`'s `getWorkspaceMail`
  // (`lib/mail-store-context.ts`). Unset ⇒ `resolveMailStoreMode` treats the
  // workspace as `postgres`, so these three go unread until mail-api's
  // Durable Objects are actually bound (design §8).
  /** mail-api's mailbox Durable Object, bound by `script_name` (one object per mailbox, always reached through `.jurisdiction('eu')`). */
  MAILBOX_STORE?: DurableObjectNamespace<MailboxStoreObject>;
  /** mail-api's per-workspace correspondent/address index, bound by `script_name`. Optional everywhere: `recentAddresses`/`messagesByCounterparty` fall back to scanning every accessible mailbox without it. */
  MAIL_INDEX?: DurableObjectNamespace<MailIndex>;
  /** EU-jurisdiction bucket for message bodies and raw MIME (decision 7) — only read by `object`/`object-only` mode's `getMessage({ bodies: true })`. */
  MAIL_STORAGE?: R2Bucket;

  // --- Outbound mail guard (@weldsuite/mail-domain/outbound) ----------------
  // `OUTBOUND_LEDGER`, `OUTBOUND_PLATFORM` and `OUTBOUND_BACKSTOP` come from
  // `OutboundGuardEnv` (Env extends them): the Durable Objects are hosted by
  // mail-api and bound with `script_name`. All optional, the guard fails open.
  // docs/plans/weldmail-outbound-abuse.md.
  /**
   * Neon connection string of the master DB. Only the guard reads it here (the
   * sender-ownership check against `mail_account_registry`); auth goes through
   * HYPERDRIVE_MASTER. Unset skips the ownership check and nothing else.
   */
  DATABASE_URL_MASTER?: string;
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

  // --- WeldReach (`/v1/reach/*`) -----------------------------------------
  // The access gate reads `WORKSPACE_CACHE` (above, reach-api's namespace) and
  // master over `HYPERDRIVE_MASTER`. Replies open the mailbox login with
  // `DATABASE_ENCRYPTION_KEY` / `_V2` (above) and read inbound mail from `STORAGE`.
  /**
   * D1 schedule index (reach-api's database): launching, resuming and enrolling
   * mark the workspace due (kind `reach_send`, keyed by Clerk org id) so the
   * send sweep picks it up. Always bind it: unset, nothing wakes the sweep, and
   * a launched campaign waits until some other write marks the workspace due.
   */
  SCHEDULE_INDEX?: D1Database;
  /** Cloudflare Flagship: the `weldreach-sending` kill switch. Unset: the flag's default (on). */
  FLAGSHIP?: FlagshipBinding;
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
  /**
   * Apps the workspace is licensed for (partner-managed workspaces), or null
   * when unrestricted. Checked per request by licenceMiddleware.
   */
  licensedApps: readonly string[] | null;
  /**
   * True when the workspace is read-only (partner suspended or licence
   * inactive): licenceMiddleware refuses writes with 403 WORKSPACE_READ_ONLY.
   * Also true, with reason `database_move`, while its tenant database is being
   * moved: writes are refused with 503 WORKSPACE_MOVING. Absent = writable.
   */
  readOnly?: boolean;
  readOnlyReason?: 'partner_suspended' | 'licence_inactive' | 'database_move' | null;
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
  /** The master `workspaces.id` of the key's workspace (= `apiSession.workspaceId`, ADR SEC-011). */
  workspaceId: string;
  /**
   * The workspace's Clerk org id, which `publishEntityEvent` stamps on every
   * event until event consumers move to `workspaces.id`, and the key of the
   * stores still keyed by it. Unset for a workspace without a Clerk org.
   */
  clerkOrgId?: string;
  /**
   * Actor id for entity events. For personal keys this is the user id; for
   * workspace keys (which have no user) it falls back to the API key id so
   * audit/workflow events still carry a stable actor.
   */
  userId: string;
  /**
   * Set by `reachAccess` on `/v1/reach/*`: the workspace's Clerk org id (the key
   * of the app access cache and the send sweep's due index) and its approved
   * WeldReach access (staff-set limits, billing state).
   */
  reach?: ReachRequest;
};

/** What the WeldReach approval gate resolved for the request. */
export interface ReachRequest {
  clerkOrgId: string;
  access: AppAccess;
}

export type HonoEnv = { Bindings: Env; Variables: Variables };

declare module 'hono' {
  interface ContextVariableMap extends Variables {}
}
