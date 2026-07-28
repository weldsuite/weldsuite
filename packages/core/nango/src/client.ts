/**
 * Fetch-based Nango REST client.
 *
 * Runs unmodified on Cloudflare Workers — no Node built-ins, no axios, no
 * `@nangohq/node`. Every call goes through `withRetry`, so rate limits and
 * Nango 5xx are absorbed here rather than in each route.
 *
 * The client is host-agnostic on purpose: `host` points at Nango Cloud today
 * and at a self-hosted origin the day we move. Nothing above this file knows
 * which one it is talking to.
 */

import { NangoApiError, classifyStatus, parseRetryAfter } from './errors';
import { withRetry, type RetryOptions } from './retry';
import type {
  ConnectSession,
  CreateConnectSessionInput,
  ListRecordsInput,
  ListRecordsResult,
  NangoClientConfig,
  NangoConnectionDetail,
  NangoConnectionSummary,
  NangoSyncStatusEntry,
  TriggerSyncInput,
} from './types';

export const NANGO_CLOUD_HOST = 'https://api.nango.dev';
export const NANGO_CLOUD_CONNECT_URL = 'https://connect.nango.dev';

const DEFAULT_TIMEOUT_MS = 20_000;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Skip retries for calls that are not safe to repeat. */
  retry?: RetryOptions | false;
}

export class NangoClient {
  private readonly secretKey: string;
  private readonly host: string;
  private readonly connectUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: NangoClientConfig) {
    if (!config.secretKey) {
      throw new Error('NangoClient requires a secretKey');
    }
    this.secretKey = config.secretKey;
    this.host = (config.host || NANGO_CLOUD_HOST).replace(/\/+$/, '');
    this.connectUrl = (config.connectUrl || NANGO_CLOUD_CONNECT_URL).replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? 3;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  // ==========================================================================
  // Transport
  // ==========================================================================

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = new URL(`${this.host}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async rawRequest<T>(options: RequestOptions): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.buildUrl(options.path, options.query), {
        method: options.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => undefined);
        throw new NangoApiError({
          message: `Nango ${options.method ?? 'GET'} ${options.path} failed with ${response.status}`,
          status: response.status,
          kind: classifyStatus(response.status),
          body,
          retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
        });
      }

      if (response.status === 204) return undefined as T;
      const text = await response.text();
      if (!text) return undefined as T;
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private request<T>(options: RequestOptions): Promise<T> {
    if (options.retry === false) return this.rawRequest<T>(options);
    return withRetry(() => this.rawRequest<T>(options), {
      maxRetries: this.maxRetries,
      ...options.retry,
    });
  }

  // ==========================================================================
  // Connect sessions — step 1 of the connect lifecycle
  // ==========================================================================

  /**
   * Mint a short-lived session token for the hosted Connect UI. The token is
   * the ONLY Nango credential that ever reaches a browser; the secret key
   * stays server-side.
   */
  async createConnectSession(input: CreateConnectSessionInput): Promise<ConnectSession> {
    const res = await this.request<{ data: ConnectSession }>({
      method: 'POST',
      path: '/connect/sessions',
      body: input,
      // Session creation is cheap and idempotent enough to retry.
      retry: { maxRetries: 2 },
    });
    return res.data;
  }

  /** Hosted Connect UI URL for a session token. */
  connectUiUrl(sessionToken: string): string {
    return `${this.connectUrl}?session_token=${encodeURIComponent(sessionToken)}`;
  }

  // ==========================================================================
  // Connections
  // ==========================================================================

  async listConnections(params: { connectionId?: string; search?: string } = {}): Promise<NangoConnectionSummary[]> {
    const res = await this.request<{ connections: NangoConnectionSummary[] }>({
      path: '/connection',
      query: { connectionId: params.connectionId, search: params.search },
    });
    return res?.connections ?? [];
  }

  /**
   * Fetch a single connection.
   *
   * `refreshToken: true` forces Nango to refresh an expired access token before
   * answering — that refresh is the whole reason credentials live in Nango and
   * not in `integration_connections.oauth_tokens`.
   */
  async getConnection(params: {
    connectionId: string;
    providerConfigKey: string;
    refreshToken?: boolean;
  }): Promise<NangoConnectionDetail> {
    return this.request<NangoConnectionDetail>({
      path: `/connection/${encodeURIComponent(params.connectionId)}`,
      query: {
        provider_config_key: params.providerConfigKey,
        refresh_token: params.refreshToken ? 'true' : undefined,
      },
    });
  }

  async deleteConnection(params: { connectionId: string; providerConfigKey: string }): Promise<void> {
    await this.request<void>({
      method: 'DELETE',
      path: `/connection/${encodeURIComponent(params.connectionId)}`,
      query: { provider_config_key: params.providerConfigKey },
    });
  }

  /** Tenant-scoped metadata stored alongside the connection inside Nango. */
  async setConnectionMetadata(params: {
    connectionId: string;
    providerConfigKey: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    await this.request<void>({
      method: 'POST',
      path: '/connection/metadata',
      body: {
        connection_id: params.connectionId,
        provider_config_key: params.providerConfigKey,
        metadata: params.metadata,
      },
    });
  }

  // ==========================================================================
  // Syncs
  // ==========================================================================

  /** Kick a sync now. Not retried — a duplicate trigger doubles provider load. */
  async triggerSync(input: TriggerSyncInput): Promise<void> {
    await this.request<void>({
      method: 'POST',
      path: '/sync/trigger',
      body: input,
      retry: false,
    });
  }

  async startSyncs(input: TriggerSyncInput): Promise<void> {
    await this.request<void>({ method: 'POST', path: '/sync/start', body: input, retry: false });
  }

  async pauseSyncs(input: TriggerSyncInput): Promise<void> {
    await this.request<void>({ method: 'POST', path: '/sync/pause', body: input, retry: false });
  }

  async getSyncStatus(params: {
    providerConfigKey: string;
    connectionId: string;
    /** Sync names, or '*' for every sync on the integration. */
    syncs?: string[];
  }): Promise<NangoSyncStatusEntry[]> {
    const res = await this.request<{ syncs: NangoSyncStatusEntry[] }>({
      path: '/sync/status',
      query: {
        provider_config_key: params.providerConfigKey,
        connection_id: params.connectionId,
        syncs: params.syncs?.length ? params.syncs.join(',') : '*',
      },
    });
    return res?.syncs ?? [];
  }

  // ==========================================================================
  // Records
  // ==========================================================================

  /** One page of synced records. */
  async listRecords<T = Record<string, unknown>>(input: ListRecordsInput): Promise<ListRecordsResult<T>> {
    const res = await this.request<ListRecordsResult<T>>({
      path: '/records',
      query: {
        model: input.model,
        modified_after: input.modifiedAfter,
        cursor: input.cursor,
        limit: input.limit,
      },
      headers: {
        'Provider-Config-Key': input.providerConfigKey,
        'Connection-Id': input.connectionId,
      },
    });
    return { records: res?.records ?? [], next_cursor: res?.next_cursor ?? null };
  }

  /**
   * Walk every page of records for a model.
   *
   * `maxPages` is a hard stop, not a suggestion — an unbounded loop inside a
   * Worker invocation is how you hit the CPU limit mid-tenant and leave the
   * cursor half-advanced. Callers get `nextCursor` back and resume next run.
   */
  async *iterateRecords<T = Record<string, unknown>>(
    input: ListRecordsInput & { maxPages?: number },
  ): AsyncGenerator<{ records: Array<ListRecordsResult<T>['records'][number]>; cursor: string | null }> {
    const maxPages = input.maxPages ?? 20;
    let cursor = input.cursor;

    for (let page = 0; page < maxPages; page++) {
      const result = await this.listRecords<T>({ ...input, cursor });
      yield { records: result.records, cursor: result.next_cursor };
      if (!result.next_cursor || result.records.length === 0) return;
      cursor = result.next_cursor;
    }
  }
}

/** Build a client from a plain env bag; returns null when Nango is unconfigured. */
export function createNangoClient(
  env: { NANGO_SECRET_KEY?: string; NANGO_HOST?: string; NANGO_CONNECT_URL?: string },
  overrides: Partial<NangoClientConfig> = {},
): NangoClient | null {
  if (!env.NANGO_SECRET_KEY) return null;
  return new NangoClient({
    secretKey: env.NANGO_SECRET_KEY,
    host: env.NANGO_HOST,
    connectUrl: env.NANGO_CONNECT_URL,
    ...overrides,
  });
}
