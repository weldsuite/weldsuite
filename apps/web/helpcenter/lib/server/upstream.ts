import { env } from 'cloudflare:workers'
import { getRequest } from '@tanstack/react-start/server'
import { domainFromHost } from '@/lib/domain'
import { cached } from '@/lib/server/cache'

/**
 * Server-only access to desk-api's public help-center mount
 * (`/public/helpcenter/*`, resolved to a tenant by `?domain=`).
 *
 * Deployed, requests go over the DESK_API service binding (the host below is
 * never resolved). Locally there is no binding, so they go to
 * HELPCENTER_API_URL: app-api from `pnpm dev:api`, which forwards the mount.
 */
const BINDING_ORIGIN = 'https://desk-api.internal'

export class UpstreamError extends Error {
  constructor(public readonly status: number) {
    super(`API error: ${status}`)
    this.name = 'UpstreamError'
  }
}

/** The help-center domain the current request is for; `''` when there is none. */
export function requestDomain(request: Request = getRequest()): string {
  return domainFromHost(request.headers.get('host') ?? new URL(request.url).host, env.FALLBACK_DOMAIN ?? '')
}

function upstreamUrl(path: string, domain: string, params?: Record<string, string | undefined>): URL {
  const origin = env.DESK_API ? BINDING_ORIGIN : env.HELPCENTER_API_URL || 'http://localhost:8789'
  const url = new URL(`/public/helpcenter${path}`, origin)
  url.searchParams.set('domain', domain)
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value) url.searchParams.set(key, value)
  }
  return url
}

function send(url: URL, init?: RequestInit): Promise<Response> {
  return env.DESK_API ? env.DESK_API.fetch(url, init) : fetch(url, init)
}

/**
 * GET a public help-center endpoint and parse its JSON body.
 * `ttl` is seconds to cache at the edge: 0 = always live.
 */
export async function getJson<T>(
  path: string,
  domain: string,
  opts: { params?: Record<string, string | undefined>; ttl: number },
): Promise<T> {
  const url = upstreamUrl(path, domain, opts.params)
  const res = await cached(url.toString(), opts.ttl, () => send(url))
  if (!res.ok) throw new UpstreamError(res.status)
  return (await res.json()) as T
}

/** POST a JSON body to a public help-center endpoint. Never cached. */
export function postJson(path: string, domain: string, body: unknown): Promise<Response> {
  return send(upstreamUrl(path, domain), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
