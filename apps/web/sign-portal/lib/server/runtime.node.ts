/**
 * Server-only: the Node version of `runtime.ts`, for the portal's container
 * on Kubernetes (ADR FE-017). The Node build (`pnpm build:node`) resolves
 * `@/lib/server/runtime` to this file (vite.config.ts). There are no
 * Cloudflare bindings here, so the portal can only call the backend:
 * `SIGN_PORTAL_BACKEND=rust` with `SIGN_PORTAL_BACKEND_URL` and
 * `SIGN_PORTAL_SECRET` (the Helm chart sets them).
 */

import { forwardedClientIp } from '@weldsuite/sign-domain/portal-client'
import type * as Workers from './runtime'

export const runtimeEnv: typeof Workers.runtimeEnv = () => process.env

/**
 * The signer's IP from `X-Forwarded-For`, as the ingress controller in front
 * of the portal reports it. `SIGN_PORTAL_TRUSTED_PROXIES` is how many proxies
 * append to the header (1, the ingress; 2 with a CDN the ingress trusts).
 */
export const signerMeta: typeof Workers.signerMeta = (request) => {
  const hops = Number.parseInt(runtimeEnv().SIGN_PORTAL_TRUSTED_PROXIES ?? '1', 10)
  return {
    ip: forwardedClientIp(request.headers.get('x-forwarded-for'), Number.isNaN(hops) ? 1 : hops),
    userAgent: request.headers.get('user-agent')?.slice(0, 500) ?? null,
  }
}

export const domainPortal: typeof Workers.domainPortal = () => {
  throw new Error(
    'The Node build of the sign portal does not run the signing domain: set SIGN_PORTAL_BACKEND=rust, ' +
      'SIGN_PORTAL_BACKEND_URL and SIGN_PORTAL_SECRET (ADR FE-017).',
  )
}
