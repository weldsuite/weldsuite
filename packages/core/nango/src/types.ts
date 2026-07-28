/**
 * Nango connector-framework types.
 *
 * These describe the Nango REST surface WeldSuite talks to — deliberately
 * hand-written rather than pulled from `@nangohq/node`, because the client runs
 * inside Cloudflare Workers where the official SDK's Node/axios dependencies
 * are dead weight. See `client.ts` for the fetch-based implementation.
 *
 * Everything here is host-agnostic: the same shapes are served by Nango Cloud
 * (`https://api.nango.dev`) and by a self-hosted Nango server. Switching is a
 * `NANGO_HOST` change — see docs/decisions/nango-connector-framework.md.
 */

// ============================================================================
// Client configuration
// ============================================================================

export interface NangoClientConfig {
  /** Nango secret key (server-side only — never leaves app-api). */
  secretKey: string;
  /** API base, e.g. `https://api.nango.dev` or a self-hosted origin. */
  host?: string;
  /** Connect UI base used to build the hosted authorisation URL. */
  connectUrl?: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Retry budget for transient failures (429 / 5xx / network). */
  maxRetries?: number;
  /** Injectable fetch — tests pass a stub, Workers pass the global. */
  fetchImpl?: typeof fetch;
}

// ============================================================================
// Connect sessions
// ============================================================================

export interface NangoEndUser {
  /** Stable per-user id. WeldSuite uses the Clerk user id. */
  id: string;
  email?: string;
  display_name?: string;
}

export interface NangoOrganization {
  /** Stable per-tenant id. WeldSuite uses the Clerk org id. */
  id: string;
  display_name?: string;
}

export interface CreateConnectSessionInput {
  end_user: NangoEndUser;
  organization?: NangoOrganization;
  allowed_integrations?: string[];
  integrations_config_defaults?: Record<
    string,
    { connection_config?: Record<string, unknown>; user_scopes?: string }
  >;
}

export interface ConnectSession {
  token: string;
  expires_at: string;
}

// ============================================================================
// Connections
// ============================================================================

export interface NangoConnectionSummary {
  id: number | string;
  connection_id: string;
  provider_config_key: string;
  provider?: string;
  created?: string;
  metadata?: Record<string, unknown> | null;
  errors?: Array<{ type: string; log_id?: string }>;
}

export interface NangoConnectionDetail extends NangoConnectionSummary {
  created_at?: string;
  updated_at?: string;
  last_fetched_at?: string;
  connection_config?: Record<string, unknown>;
  credentials?: {
    type?: string;
    access_token?: string;
    refresh_token?: string;
    expires_at?: string;
    raw?: Record<string, unknown>;
  };
  end_user?: {
    id: string;
    email?: string;
    display_name?: string;
    organization?: { id: string; display_name?: string };
  };
}

// ============================================================================
// Syncs
// ============================================================================

export type NangoSyncStatus = 'RUNNING' | 'SUCCESS' | 'ERROR' | 'PAUSED' | 'STOPPED';

export interface NangoSyncStatusEntry {
  id?: string;
  name: string;
  status: NangoSyncStatus;
  type?: 'INCREMENTAL' | 'INITIAL' | 'FULL';
  finishedAt?: string | null;
  nextScheduledSyncAt?: string | null;
  frequency?: string | null;
  latestResult?: Record<string, { added: number; updated: number; deleted?: number }> | null;
  recordCount?: Record<string, number> | null;
  error?: { type?: string; message?: string } | null;
}

export interface TriggerSyncInput {
  provider_config_key: string;
  connection_id: string;
  /** Sync names to run. Omit to run every sync on the integration. */
  syncs?: string[];
  /** Discard the incremental cursor and re-fetch everything. */
  full_resync?: boolean;
}

// ============================================================================
// Records
// ============================================================================

/** Nango stamps every synced record with this envelope. */
export interface NangoRecordMetadata {
  first_seen_at: string;
  last_modified_at: string;
  last_action: 'ADDED' | 'UPDATED' | 'DELETED';
  deleted_at: string | null;
  cursor: string;
}

export type NangoRecord<T = Record<string, unknown>> = T & {
  id: string;
  _nango_metadata: NangoRecordMetadata;
};

export interface ListRecordsInput {
  providerConfigKey: string;
  connectionId: string;
  model: string;
  /** Incremental watermark — only records changed after this instant. */
  modifiedAfter?: string;
  cursor?: string;
  limit?: number;
}

export interface ListRecordsResult<T = Record<string, unknown>> {
  records: Array<NangoRecord<T>>;
  next_cursor: string | null;
}

// ============================================================================
// Webhooks
// ============================================================================

export interface NangoAuthWebhook {
  type: 'auth';
  from: string;
  operation: 'creation' | 'override' | 'refresh';
  connectionId: string;
  providerConfigKey: string;
  provider?: string;
  authMode?: string;
  success: boolean;
  error?: { type?: string; description?: string };
  endUser?: {
    endUserId: string;
    organizationId?: string | null;
  };
}

export interface NangoSyncWebhook {
  type: 'sync';
  from: string;
  connectionId: string;
  providerConfigKey: string;
  provider?: string;
  syncName: string;
  model: string;
  success: boolean;
  syncType?: 'INCREMENTAL' | 'INITIAL' | 'WEBHOOK' | 'FULL';
  modifiedAfter?: string;
  /** Only present on `success: true`. */
  responseResults?: { added: number; updated: number; deleted?: number };
  error?: { type?: string; description?: string };
  startedAt?: string;
  failedAt?: string;
}

export interface NangoForwardWebhook {
  type: 'forward';
  from: string;
  connectionId: string;
  providerConfigKey: string;
  payload: unknown;
}

export type NangoWebhook = NangoAuthWebhook | NangoSyncWebhook | NangoForwardWebhook;
