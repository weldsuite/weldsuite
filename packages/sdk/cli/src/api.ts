import { cyan } from './log.js';
import { missingAuthMessage, readCredentials } from './credentials.js';
import { defaultExternalApiUrl } from './env.js';
import { ApiError, CliError } from './errors.js';

export { ApiError, CliError } from './errors.js';

export interface CliConfig {
  apiKey: string;
  apiUrl: string;
  /** True when auth came from WELD_API_KEY rather than the credentials file. */
  fromEnv: boolean;
}

/**
 * Resolve API credentials.
 *
 * Precedence: `WELD_API_KEY` (CI / scripts) → local `weld login` session → error.
 * `WELD_API_URL` overrides the stored/default external-api base when set.
 */
export function loadConfig(): CliConfig {
  const envKey = process.env.WELD_API_KEY;
  const envUrl = process.env.WELD_API_URL;

  if (envKey) {
    const apiUrl = (envUrl ?? defaultExternalApiUrl()).replace(/\/+$/, '');
    return { apiKey: envKey, apiUrl, fromEnv: true };
  }

  const stored = readCredentials();
  if (stored) {
    const apiUrl = (envUrl ?? stored.apiUrl ?? defaultExternalApiUrl()).replace(/\/+$/, '');
    return { apiKey: stored.apiKey, apiUrl, fromEnv: false };
  }

  throw new CliError(missingAuthMessage());
}

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
}

export interface RequestOptions {
  /** JSON body — serialized and sent with Content-Type: application/json. */
  body?: unknown;
  /** Multipart body — sent as-is (fetch sets the boundary header). */
  form?: FormData;
}

/**
 * Perform a request against the WeldSuite external API and unwrap the
 * `{ data }` envelope. Errors surface as {@link ApiError} rendered from
 * `{ error: { code, message } }`.
 */
export async function apiRequest<T>(
  config: CliConfig,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
  };
  let body: string | FormData | undefined;
  if (options.form) {
    body = options.form;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(`${config.apiUrl}${path}`, { method, headers, body });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new CliError(`Could not reach ${config.apiUrl} — ${detail}\nCheck WELD_API_URL and your network.`);
  }

  const text = await response.text();
  let json: unknown;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }

  if (!response.ok) {
    const errorBody = (json as ApiErrorBody | undefined)?.error;
    const code = errorBody?.code ?? 'http_error';
    const message = errorBody?.message ?? `HTTP ${response.status} ${response.statusText}`;
    if (response.status === 401) {
      throw new ApiError(
        `${message}\nCredentials were rejected — run ${cyan('weld login')} again or check WELD_API_KEY.`,
        code,
        401,
      );
    }
    throw new ApiError(`${message} ${`(${code}, HTTP ${response.status})`}`, code, response.status);
  }

  if (response.status === 204 || json === undefined) {
    return undefined as T;
  }
  const envelope = json as { data?: unknown };
  return (envelope.data !== undefined ? envelope.data : json) as T;
}

/** Fields we read from a `GET /v1/user-apps` list item (defensively typed). */
export interface UserAppSummary {
  id: string;
  code: string;
  name: string;
  visibility?: string;
  reviewStatus?: string;
  review_status?: string;
  installCount?: number;
  installs?: number;
  isActive?: boolean;
}

/** List the caller's apps. */
export async function listApps(config: CliConfig): Promise<UserAppSummary[]> {
  return apiRequest<UserAppSummary[]>(config, 'GET', '/v1/user-apps?limit=100');
}

/** Resolve an app id by manifest code, with a hint to run `weld app create`. */
export async function resolveAppId(config: CliConfig, code: string): Promise<string> {
  const apps = await listApps(config);
  const match = apps.find((app) => app.code === code);
  if (!match) {
    throw new CliError(
      `No app with code "${code}" found in your workspace.\n` +
        `Run ${cyan('weld app create')} first to register the app from weldapp.json.`,
    );
  }
  return match.id;
}

export interface DevSession {
  url: string;
  expiresAt: string;
}

/** Register or heartbeat a per-developer preview URL. */
export async function putDevSession(
  config: CliConfig,
  appId: string,
  url: string,
  userId?: string,
): Promise<DevSession> {
  return apiRequest<DevSession>(config, 'PUT', `/v1/user-apps/${encodeURIComponent(appId)}/dev-session`, {
    body: { url, ...(userId ? { userId } : {}) },
  });
}

/** Clear the preview session when `weld app dev` exits. */
export async function deleteDevSession(config: CliConfig, appId: string, userId?: string): Promise<void> {
  const query = userId ? `?userId=${encodeURIComponent(userId)}` : '';
  await apiRequest<void>(
    config,
    'DELETE',
    `/v1/user-apps/${encodeURIComponent(appId)}/dev-session${query}`,
  );
}
