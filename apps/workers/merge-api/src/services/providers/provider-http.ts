/**
 * HTTP plumbing for the GitLab, Bitbucket and Azure DevOps adapters: one
 * `fetch` per call, the provider's own message passed through as a
 * `ProviderApiError`, a 404 read as "not there" on reads. No Hono context, no
 * retries, no hidden calls: every outbound call is deterministic for a given
 * input (the Rust backend answers the same tests call for call).
 */

import type { MergeProvider } from '@weldsuite/app-api-client/schemas/weldmerge';
import type { MergeStoredCredentials } from '@weldsuite/app-api-client/schemas/weldmerge-providers';
import { openCredentials } from '../credentials-seal';
import { ProviderApiError, type AdapterContext } from './types';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function messageOf(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object') return JSON.stringify(value);
  return null;
}

/** The provider's own words for a failure (`message`, `error_description`, `error.message`, `error`, or the raw body). */
export function failureMessage(status: number, text: string): string {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const nested = (body.error as { message?: unknown } | undefined)?.message;
    const found = messageOf(body.message) ?? messageOf(body.error_description) ?? messageOf(nested) ?? messageOf(body.error);
    if (found) return found;
  } catch {
    if (text.trim()) return text.trim().slice(0, 500);
  }
  return `Provider answered ${status}`;
}

export interface HttpRequest {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  /** Sent as JSON. */
  json?: unknown;
  /** Sent as `application/x-www-form-urlencoded`. */
  form?: Record<string, string>;
}

/** Sends the request; throws `ProviderApiError` on a non-2xx answer. Returns the response for the caller to read. */
export async function sendRequest(provider: MergeProvider, req: HttpRequest): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'WeldSuite-WeldMerge', ...req.headers };
  const init: RequestInit = { method: req.method, headers };
  if (req.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(req.json);
  } else if (req.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(req.form).toString();
  }
  let res: Response;
  try {
    res = await fetch(req.url, init);
  } catch (err) {
    // A host that cannot be reached is the provider failing, not the worker.
    const reason = err instanceof Error ? err.message : 'request failed';
    throw new ProviderApiError(provider, 502, `Could not reach ${new URL(req.url).host}: ${reason}`);
  }
  if (!res.ok) throw new ProviderApiError(provider, res.status, failureMessage(res.status, await res.text()));
  return res;
}

async function readJson<T>(res: Response): Promise<T | null> {
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : null;
}

/** The parsed JSON of a successful answer; null for an empty one. */
export async function requestJson<T>(provider: MergeProvider, req: HttpRequest): Promise<T | null> {
  return readJson<T>(await sendRequest(provider, req));
}

export interface ApiClient {
  /** The parsed JSON body, or null on a 404. */
  get<T>(path: string): Promise<T | null>;
  /** A write; any non-2xx answer (404 included) throws. */
  send<T>(method: Exclude<HttpMethod, 'GET'>, path: string, json?: unknown): Promise<T | null>;
}

/**
 * The token an adapter acts with: `memberToken` when the caller put one on the
 * context (a member's own, or the connection's resolved and refreshed by
 * `adapterContext`), else the connection's stored token as it is (not
 * refreshed: only `credentials.ts` persists a refresh). No token is a 401.
 */
export async function accessTokenOf(provider: MergeProvider, ctx: AdapterContext): Promise<string> {
  if (ctx.memberToken) return ctx.memberToken;
  const stored = await openCredentials(ctx.env, ctx.connection.credentials);
  if (!stored) throw new ProviderApiError(provider, 401, `No ${provider} credentials are available for this call`);
  return stored.accessToken;
}

/**
 * A client for one provider API: `path` is appended to `base` unless it is an
 * absolute URL (Bitbucket's `next`). `auth` supplies the headers per call, so
 * the token is read only when a call is made.
 */
export function createApiClient(provider: MergeProvider, base: string, auth: () => Promise<Record<string, string>>): ApiClient {
  const urlOf = (path: string) => (/^https?:\/\//.test(path) ? path : `${base}${path}`);
  return {
    async get<T>(path: string): Promise<T | null> {
      try {
        return await requestJson<T>(provider, { method: 'GET', url: urlOf(path), headers: await auth() });
      } catch (err) {
        if (err instanceof ProviderApiError && err.status === 404) return null;
        throw err;
      }
    },
    async send<T>(method: Exclude<HttpMethod, 'GET'>, path: string, json?: unknown): Promise<T | null> {
      return requestJson<T>(provider, { method, url: urlOf(path), headers: await auth(), json });
    },
  };
}

/** `Authorization: Bearer` with the context's token, resolved lazily. */
export const bearerAuth =
  (provider: MergeProvider, ctx: AdapterContext) => async (): Promise<Record<string, string>> => ({
    Authorization: `Bearer ${await accessTokenOf(provider, ctx)}`,
  });


export const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

/** `ProviderApiError` with this status, for a `catch` that tolerates it (a hook already deleted). */
export const isStatus = (err: unknown, ...statuses: number[]): boolean =>
  err instanceof ProviderApiError && statuses.includes(err.status);

/** Stored credentials from an OAuth token response (`expires_in` is seconds from `now`). */
export function credentialsFromToken(
  body: { access_token?: string; refresh_token?: string; expires_in?: number | string; token_type?: string },
  provider: MergeProvider,
  now: Date = new Date(),
): MergeStoredCredentials {
  if (!body.access_token) throw new ProviderApiError(provider, 502, 'The provider did not return an access token');
  const seconds = Number(body.expires_in);
  return {
    accessToken: body.access_token,
    ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    ...(Number.isFinite(seconds) && seconds > 0 ? { expiresAt: new Date(now.getTime() + seconds * 1000).toISOString() } : {}),
    ...(body.token_type ? { tokenType: body.token_type } : {}),
  };
}

/** The first of the pages a paginated list returns, capped: `read` fetches page `n` and says whether more may follow. */
export async function collectPages<T>(read: (page: number) => Promise<{ rows: T[]; more: boolean }>, maxPages: number, cap: number): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages && out.length < cap; page++) {
    const { rows, more } = await read(page);
    out.push(...rows);
    if (!more) break;
  }
  return out.slice(0, cap);
}
