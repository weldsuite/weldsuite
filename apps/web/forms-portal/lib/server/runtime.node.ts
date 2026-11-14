/**
 * Server-only: the Node version of `runtime.ts`, for the portal's container on
 * Kubernetes (ADR FE-017). The Node build (`pnpm build:node`) resolves
 * `@/lib/server/runtime` to this file (vite.config.ts). There are no
 * Cloudflare bindings here, so the portal reaches the backend over HTTP:
 * `FORMS_PORTAL_BACKEND_URL` and `FORMS_PORTAL_SECRET` (the Helm chart sets
 * them), and `FORMS_PORTAL_TRUSTED_PROXIES` for the respondent's address.
 */

import { forwardedClientIp } from '@/lib/forwarded-ip'
import type * as Workers from './runtime'

const PREFIX = '/public/forms'

/** Drops every trailing slash with a single scan (a `/\/+$/` regex backtracks quadratically on long runs). */
function stripTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value[end - 1] === '/') end--
  return value.slice(0, end)
}

export const backend: typeof Workers.backend = () => {
  const origin = stripTrailingSlashes(process.env.FORMS_PORTAL_BACKEND_URL ?? '')
  if (!origin) throw new Error('FORMS_PORTAL_BACKEND_URL is not set: the forms portal has no backend to talk to (ADR FE-017).')
  return { base: `${origin}${PREFIX}`, secret: process.env.FORMS_PORTAL_SECRET, send: (url, init) => fetch(url, init) }
}

/**
 * The respondent's IP from `X-Forwarded-For`, as the ingress controller in
 * front of the portal reports it. `FORMS_PORTAL_TRUSTED_PROXIES` is how many
 * proxies append to the header (1, the ingress; 2 with a CDN the ingress trusts).
 */
export const respondentIp: typeof Workers.respondentIp = (request) => {
  const hops = Number.parseInt(process.env.FORMS_PORTAL_TRUSTED_PROXIES ?? '1', 10)
  return forwardedClientIp(request.headers.get('x-forwarded-for'), Number.isNaN(hops) ? 1 : hops)
}

/** Behind an ingress there is no country header the portal can trust; `X-Respondent-Country` is simply left out. */
export const respondentCountry: typeof Workers.respondentCountry = () => null
