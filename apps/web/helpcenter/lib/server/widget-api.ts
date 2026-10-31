import { env } from 'cloudflare:workers'
import type { DeskPortalConfig } from '@weldsuite/app-api-client/schemas/desk-portal'
import { cached } from '@/lib/server/cache'

/**
 * Server-only access to helpdesk-widget-api's signed-in help center
 * (`/api/portal/*`, tenant from `?domain=`, reader from `x-portal-session`).
 *
 * Deployed, requests go over the WIDGET_API service binding (the host below
 * is never resolved). Locally there is no binding, so they go to
 * WIDGET_API_URL: `wrangler dev` of helpdesk-widget-api.
 *
 * Everything except `/config` is per reader, so it never goes through the
 * edge cache.
 */
const BINDING_ORIGIN = 'https://helpdesk-widget-api.internal'
const SESSION_HEADER = 'x-portal-session'
/** Whether sign-in is on changes rarely; a minute of lag is fine. */
const CONFIG_TTL = 60

export interface PortalApiError {
  code: string
  message: string
  details?: unknown
}

export type PortalApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: PortalApiError }

function portalUrl(path: string, domain: string, params?: Record<string, string | undefined>): URL {
  const origin = env.WIDGET_API ? BINDING_ORIGIN : env.WIDGET_API_URL || 'http://localhost:8787'
  const url = new URL(`/api/portal${path}`, origin)
  url.searchParams.set('domain', domain)
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value) url.searchParams.set(key, value)
  }
  return url
}

function send(url: URL, init?: RequestInit): Promise<Response> {
  return env.WIDGET_API ? env.WIDGET_API.fetch(url, init) : fetch(url, init)
}

function fallbackCode(status: number): string {
  if (status === 401) return 'SIGN_IN_REQUIRED'
  if (status === 404) return 'NOT_FOUND'
  if (status === 429) return 'RATE_LIMITED'
  if (status === 400) return 'BAD_REQUEST'
  return 'UPSTREAM_ERROR'
}

/** Reads the `{ success, data } | { success: false, error }` envelope. */
async function readResult<T>(res: Response): Promise<PortalApiResult<T>> {
  if (res.status === 204) return { ok: true, status: 204, data: undefined as T }
  const json = (await res.json().catch(() => null)) as
    | { success?: boolean; data?: T; error?: unknown }
    | null
  if (res.ok && json && json.success !== false) return { ok: true, status: res.status, data: json.data as T }

  const raw = json?.error as Partial<PortalApiError> | undefined
  return {
    ok: false,
    status: res.status,
    error:
      raw && typeof raw.code === 'string'
        ? { code: raw.code, message: String(raw.message ?? ''), details: raw.details }
        : { code: fallbackCode(res.status), message: `helpdesk-widget-api answered ${res.status}` },
  }
}

/** One call to `/api/portal{path}`. Network failures come back as 503 UNAVAILABLE. */
export async function portalApi<T>(
  path: string,
  domain: string,
  opts: {
    method?: 'GET' | 'POST'
    session?: string
    body?: unknown
    params?: Record<string, string | undefined>
  } = {},
): Promise<PortalApiResult<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.session) headers[SESSION_HEADER] = opts.session

  try {
    const res = await send(portalUrl(path, domain, opts.params), {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
    return await readResult<T>(res)
  } catch (err) {
    console.error('[helpcenter/portal] helpdesk-widget-api unreachable:', err)
    return { ok: false, status: 503, error: { code: 'UNAVAILABLE', message: 'helpdesk-widget-api unreachable' } }
  }
}

/** Is sign-in switched on for this help center? Any failure reads as off. */
export async function isPortalEnabled(domain: string): Promise<boolean> {
  if (!domain) return false
  try {
    const url = portalUrl('/config', domain)
    const res = await cached(url.toString(), CONFIG_TTL, () => send(url, { headers: { Accept: 'application/json' } }))
    const result = await readResult<DeskPortalConfig>(res)
    return result.ok && result.data?.enabled === true
  } catch {
    return false
  }
}
