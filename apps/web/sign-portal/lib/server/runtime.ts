/**
 * Server-only: what the portal takes from the platform it runs on, its Node
 * container on Kubernetes (ADR FE-017). There are no Cloudflare bindings, so
 * the portal only calls the backend: `SIGN_PORTAL_BACKEND=rust` with
 * `SIGN_PORTAL_BACKEND_URL` and `SIGN_PORTAL_SECRET` (the Helm chart sets
 * them). Never import this from a client component.
 */

import { forwardedClientIp, type SignerMeta } from '@/lib/server/portal-client'

/** The process environment: text variables and secrets. */
export function runtimeEnv(): Record<string, string | undefined> {
  return process.env
}

/**
 * The signer's IP and browser for the evidence trail. The IP comes from
 * `X-Forwarded-For`, as the ingress controller in front of the portal reports
 * it. `SIGN_PORTAL_TRUSTED_PROXIES` is how many proxies append to the header
 * (1, the ingress; 2 with a CDN the ingress trusts).
 */
export function signerMeta(request: Request): SignerMeta {
  const hops = Number.parseInt(runtimeEnv().SIGN_PORTAL_TRUSTED_PROXIES ?? '1', 10)
  return {
    ip: forwardedClientIp(request.headers.get('x-forwarded-for'), Number.isNaN(hops) ? 1 : hops),
    userAgent: request.headers.get('user-agent')?.slice(0, 500) ?? null,
  }
}
