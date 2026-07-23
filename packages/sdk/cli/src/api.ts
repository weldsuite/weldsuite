import { bold, cyan } from './log.js';

const DEFAULT_API_URL = 'https://api.weldsuite.org';

export interface CliConfig {
  apiKey: string;
  apiUrl: string;
}

/** Error whose message is already user-friendly — rendered without a stack trace. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

/** A structured `{ error: { code, message } }` response from the API. */
export class ApiError extends CliError {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/** Read WELD_API_KEY / WELD_API_URL from the environment. */
export function loadConfig(): CliConfig {
  const apiKey = process.env.WELD_API_KEY;
  if (!apiKey) {
    throw new CliError(
      [
        `${bold('WELD_API_KEY is not set.')}`,
        '',
        'The weld CLI talks to the WeldSuite API with a workspace API key (wsk_…).',
        'Create one in your workspace under Settings → API keys, then run:',
        '',
        `  ${cyan('export WELD_API_KEY=wsk_...')}`,
        '',
        `Optionally set ${cyan('WELD_API_URL')} to target a non-production API (default: ${DEFAULT_API_URL}).`,
      ].join('\n'),
    );
  }
  const apiUrl = (process.env.WELD_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, '');
  return { apiKey, apiUrl };
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
      throw new ApiError(`${message}\nYour WELD_API_KEY was rejected — check it is a valid wsk_… key.`, code, 401);
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
