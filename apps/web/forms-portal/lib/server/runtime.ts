/**
 * Server-only: what the portal takes from the platform it runs on. This is
 * the Cloudflare Workers version (Global). The Node build for Kubernetes
 * (`pnpm build:node`, ADR FE-017) resolves this module to `runtime.node.ts`
 * instead (vite.config.ts), so it carries no Workers code. Never import this
 * from a client component.
 */

import { env } from 'cloudflare:workers'

/** Where /public/forms/* is served and how to reach it. */
export interface Backend {
  /** Origin + `/public/forms`, e.g. `http://localhost:8828/public/forms`. */
  base: string
  /** The shared key for X-Forms-Portal-Key; undefined when the deployment has none. */
  secret: string | undefined
  send: (url: string, init: RequestInit) => Promise<Response>
}

const BINDING_ORIGIN = 'https://forms-api.internal'
const DEFAULT_URL = 'http://localhost:8828'
const PREFIX = '/public/forms'

/** Over the FORMS_API service binding when deployed, over HTTP to FORMS_API_URL in local dev. */
export function backend(): Backend {
  const binding = env.FORMS_API
  if (binding) {
    return { base: `${BINDING_ORIGIN}${PREFIX}`, secret: env.FORMS_PORTAL_SECRET, send: (url, init) => binding.fetch(url, init) }
  }
  return { base: `${env.FORMS_API_URL || DEFAULT_URL}${PREFIX}`, secret: env.FORMS_PORTAL_SECRET, send: (url, init) => fetch(url, init) }
}

/** The respondent's IP, straight from Cloudflare's edge (`CF-Connecting-IP`), which a browser cannot set. */
export function respondentIp(request: Request): string | null {
  return request.headers.get('cf-connecting-ip')
}

/** The respondent's country from Cloudflare (`CF-IPCountry`). */
export function respondentCountry(request: Request): string | null {
  const country = request.headers.get('cf-ipcountry')
  return country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null
}
