/**
 * Mailpool REST client (WeldSuite's own Mailpool account, resold to approved
 * workspaces). Plain `fetch`, no SDK.
 *
 *   base    env.MAILPOOL_API_URL ?? https://app.mailpool.io/v1/api
 *   auth    X-Api-Authorization: <MAILPOOL_API_KEY>
 *   retry   429 / 5xx and network failures, exponential backoff with jitter,
 *           at most MAX_RETRIES retries. Mailpool documents no rate limits, so
 *           backing off is the only protection. Creating things (POST) is only
 *           retried on 429 / 503, where the request was certainly not
 *           processed: retrying a POST after a 500 could create a mailbox
 *           twice, and every mailbox costs money.
 *
 * Never call app.mailpool.ai (the web app's host) from here: the Cloudflare
 * connect endpoints below exist only there today and are being added to the
 * public API.
 */

import type { Env } from '../../types';
import { MailpoolError, MailpoolNotConfiguredError } from './errors';
import type {
  CreateMailpoolMailboxInput,
  MailpoolCloudflareConnectResponse,
  MailpoolCloudflareZone,
  MailpoolCloudflareZonesResponse,
  MailpoolDmarcPolicy,
  MailpoolDnsRecord,
  MailpoolDomain,
  MailpoolMailbox,
  MailpoolSlotType,
  MailpoolSubscriptionSlots,
  MailpoolWarmupDetail,
  MailpoolWarmupInbox,
  MailpoolWarmupStatus,
  UpdateMailpoolMailboxInput,
} from './types';

export const MAILPOOL_DEFAULT_BASE_URL = 'https://app.mailpool.io/v1/api';

/**
 * Cloudflare connect: attach a domain whose zone sits in the Cloudflare account
 * already linked to our Mailpool account. Mailpool writes the mail records
 * with its Cloudflare token; DNS stays on Cloudflare.
 *
 * Paths and shapes follow Mailpool's web-app endpoints (`GET /domains/cloudflare/zones`
 * and `POST /domains/cloudflare/connect`).
 * verify against Mailpool's public API when it ships (plan: Delivery / Phase 2).
 */
export const MAILPOOL_CLOUDFLARE_ZONES_PATH = '/domains/cloudflare/zones';
export const MAILPOOL_CLOUDFLARE_CONNECT_PATH = '/domains/cloudflare/connect';

export const MAX_RETRIES = 3;
export const REQUEST_TIMEOUT_MS = 15_000;
const BASE_BACKOFF_MS = 300;
const MAX_BACKOFF_MS = 5_000;

export interface MailpoolClientOptions {
  /** Injected in tests; defaults to the global `fetch` looked up at call time. */
  fetch?: typeof fetch;
  /** Injected in tests so backoff does not slow them down. */
  sleep?: (ms: number) => Promise<void>;
  /** Retries after the first attempt. Default 3. */
  maxRetries?: number;
  timeoutMs?: number;
}

type MailpoolEnv = Pick<Env, 'MAILPOOL_API_KEY' | 'MAILPOOL_API_URL'>;

interface RequestInitLike {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export type MailpoolClient = ReturnType<typeof createMailpoolClient>;

/** `value` without trailing slashes (a character scan: a `/\/+$/` regex backtracks on long runs). */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

/** A whole number in [0, bound) from the Web Crypto source, used as retry jitter. */
function randomBelow(bound: number): number {
  const [value] = crypto.getRandomValues(new Uint32Array(1));
  return (value ?? 0) % bound;
}

/** `base` + `path`, plus the defined query values as a query string. */
function buildUrl(base: string, path: string, query: RequestInitLike['query']): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${base}${path}?${qs}` : `${base}${path}`;
}

/** Throws MailpoolNotConfiguredError when the API key is missing. */
export function createMailpoolClient(env: MailpoolEnv, options: MailpoolClientOptions = {}) {
  const apiKey = env.MAILPOOL_API_KEY;
  if (!apiKey) throw new MailpoolNotConfiguredError();

  const baseUrl = trimTrailingSlashes(env.MAILPOOL_API_URL || MAILPOOL_DEFAULT_BASE_URL);
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));

  async function attempt(
    method: string,
    path: string,
    url: string,
    init: RequestInitLike,
  ): Promise<{ response: Response } | { failure: MailpoolError }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(url, {
        method,
        headers: {
          'X-Api-Authorization': apiKey as string,
          Accept: 'application/json',
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
      return { response };
    } catch (err) {
      return { failure: new MailpoolError({ method, path, status: 0, cause: err }) };
    } finally {
      clearTimeout(timer);
    }
  }

  function shouldRetry(method: string, status: number): boolean {
    if (status === 429) return true;
    // A POST that got a 5xx may have been processed (a mailbox created): only retry
    // statuses that mean "not processed".
    if (method === 'POST') return status === 503;
    return status >= 500;
  }

  function backoffMs(retry: number, response?: Response): number {
    const retryAfter = response?.headers.get('Retry-After');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
    }
    const exponential = BASE_BACKOFF_MS * 2 ** retry;
    return Math.min(exponential + randomBelow(100), MAX_BACKOFF_MS);
  }

  async function readBody(response: Response): Promise<unknown> {
    const text = await response.text().catch(() => '');
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  async function request<T>(method: string, path: string, init: RequestInitLike = {}): Promise<T> {
    const url = buildUrl(baseUrl, path, init.query);

    for (let retry = 0; ; retry++) {
      const outcome = await attempt(method, path, url, init);

      if ('failure' in outcome) {
        // No response: the request may or may not have arrived. Only repeat what is safe to repeat.
        if (method !== 'POST' && retry < maxRetries) {
          await sleep(backoffMs(retry));
          continue;
        }
        throw outcome.failure;
      }

      const { response } = outcome;
      if (response.ok) return (await readBody(response)) as T;

      if (shouldRetry(method, response.status) && retry < maxRetries) {
        await sleep(backoffMs(retry, response));
        continue;
      }
      throw new MailpoolError({ method, path, status: response.status, body: await readBody(response) });
    }
  }

  const segment = (id: string | number) => encodeURIComponent(String(id));

  return {
    // ── Domains ──────────────────────────────────────────────────────────
    getDomain: (id: string | number) => request<MailpoolDomain>('GET', `/domains/${segment(id)}`),
    deleteDomain: (id: string | number) => request<MailpoolDomain>('DELETE', `/domains/${segment(id)}`),
    getDomainDns: (id: string | number) => request<MailpoolDnsRecord[]>('GET', `/domains/${segment(id)}/dns`),
    updateDomainDns: (id: string | number, records: MailpoolDnsRecord[]) =>
      request<MailpoolDnsRecord[]>('PUT', `/domains/${segment(id)}/dns`, { body: records }),
    setDmarcPolicy: (id: string | number, policy: MailpoolDmarcPolicy) =>
      request<MailpoolDomain>('POST', `/domains/${segment(id)}/dmarc-policy`, { body: { policy } }),
    setDmarcEmail: (id: string | number, email: string) =>
      request<MailpoolDomain>('POST', `/domains/${segment(id)}/dmarc-email`, { body: { email } }),

    /** Zones of the linked Cloudflare account. verify against Mailpool's public API when it ships. */
    async listCloudflareZones(): Promise<MailpoolCloudflareZone[]> {
      const res = await request<MailpoolCloudflareZonesResponse>('GET', MAILPOOL_CLOUDFLARE_ZONES_PATH);
      return res?.zones ?? [];
    },
    /** Connect domains already in the linked Cloudflare account. verify against Mailpool's public API when it ships. */
    async connectCloudflareDomains(domains: string[]): Promise<MailpoolCloudflareConnectResponse> {
      const res = await request<Partial<MailpoolCloudflareConnectResponse> | undefined>(
        'POST',
        MAILPOOL_CLOUDFLARE_CONNECT_PATH,
        { body: { domains } },
      );
      return { connected: res?.connected ?? [], skipped: res?.skipped ?? [] };
    },

    // ── Mailboxes ────────────────────────────────────────────────────────
    /** Create one mailbox (the API takes an array and answers `{ emails: [...] }`). */
    async createMailbox(input: CreateMailpoolMailboxInput): Promise<MailpoolMailbox> {
      const res = await request<{ emails?: MailpoolMailbox[] } | undefined>('POST', '/mailboxes', { body: [input] });
      const mailbox = res?.emails?.[0];
      if (!mailbox) {
        throw new MailpoolError({
          method: 'POST',
          path: '/mailboxes',
          status: 502,
          message: 'Mailpool accepted the request but returned no mailbox',
        });
      }
      return mailbox;
    },
    async listMailboxes(
      params: { domainId?: string | number; limit?: number; offset?: number } = {},
    ): Promise<{ data: MailpoolMailbox[]; total: number }> {
      const res = await request<{ data?: MailpoolMailbox[]; total?: number } | undefined>('GET', '/mailboxes', {
        query: { domainId: params.domainId, limit: params.limit ?? 100, offset: params.offset ?? 0 },
      });
      return { data: res?.data ?? [], total: res?.total ?? 0 };
    },
    getMailbox: (id: string | number) => request<MailpoolMailbox>('GET', `/mailboxes/${segment(id)}`),
    updateMailbox: (id: string | number, patch: UpdateMailpoolMailboxInput) =>
      request<MailpoolMailbox>('PUT', `/mailboxes/${segment(id)}`, { body: patch }),
    /** Schedules deletion (Mailpool keeps the mailbox for a grace period). */
    deleteMailbox: (id: string | number) => request<MailpoolMailbox>('DELETE', `/mailboxes/${segment(id)}`),
    cancelMailboxDeletion: (id: string | number) =>
      request<MailpoolMailbox>('POST', `/mailboxes/${segment(id)}/cancel-deletion`),

    // ── Warmup ───────────────────────────────────────────────────────────
    addToWarmup: (mailboxIds: number[]) => request<MailpoolWarmupInbox[]>('POST', '/warmup', { body: { mailboxIds } }),
    async listWarmup(
      params: { limit?: number; offset?: number; search?: string; status?: MailpoolWarmupStatus } = {},
    ): Promise<{ data: MailpoolWarmupInbox[]; total: number }> {
      const res = await request<{ data?: MailpoolWarmupInbox[]; total?: number } | undefined>('GET', '/warmup', {
        query: { limit: params.limit ?? 100, offset: params.offset ?? 0, search: params.search, status: params.status },
      });
      return { data: res?.data ?? [], total: res?.total ?? 0 };
    },
    getWarmup: (warmupId: number) => request<MailpoolWarmupDetail>('GET', `/warmup/${segment(warmupId)}`),
    startWarmup: (warmupId: number) => request<MailpoolWarmupInbox>('POST', `/warmup/${segment(warmupId)}/start`),
    pauseWarmup: (warmupId: number) => request<MailpoolWarmupInbox>('POST', `/warmup/${segment(warmupId)}/pause`),
    removeFromWarmup: (warmupId: number) => request<MailpoolWarmupInbox>('DELETE', `/warmup/${segment(warmupId)}`),

    // ── Subscription slots ───────────────────────────────────────────────
    async getSlots(): Promise<MailpoolSubscriptionSlots> {
      const res = await request<Partial<MailpoolSubscriptionSlots> | undefined>('GET', '/subscriptions/slots');
      return { mailboxes: res?.mailboxes ?? {}, slots: res?.slots ?? {} };
    },
    increaseSlots: (type: MailpoolSlotType, increaseBy: number) =>
      request<void>('POST', '/subscriptions/increase', { body: { type, increaseBy } }),
    decreaseSlots: (type: MailpoolSlotType, decreaseBy: number) =>
      request<void>('POST', '/subscriptions/decrease', { body: { type, decreaseBy } }),
  };
}
