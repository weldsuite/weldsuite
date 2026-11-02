/**
 * Server-only: what the portal takes from the platform it runs on. This is
 * the Cloudflare Workers version (Global, ADR FE-016). The Node build for
 * Kubernetes (`pnpm build:node`, ADR FE-017) resolves this module to
 * `runtime.node.ts` instead (vite.config.ts), so it carries no Workers code.
 * Never import this from a client component.
 */

import { env, waitUntil } from 'cloudflare:workers'
import { createSignPortal, type PortalContext, type SignerMeta } from '@weldsuite/sign-domain/portal'
import type { SignerPortal } from '@/lib/server/signer-portal'

/** The Worker's text variables and secrets. */
export function runtimeEnv(): Record<string, string | undefined> {
  const vars: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string') vars[name] = value
  }
  return vars
}

/**
 * The signer's IP and browser for the evidence trail. The IP comes straight
 * from Cloudflare's edge (`CF-Connecting-IP`), which a browser cannot set.
 */
export function signerMeta(request: Request): SignerMeta {
  return {
    ip: request.headers.get('cf-connecting-ip'),
    userAgent: request.headers.get('user-agent')?.slice(0, 500) ?? null,
  }
}

/**
 * The domain code run by this Worker, against its own bindings: the master
 * and tenant DBs, R2, KV and the queue. There is no API in between.
 */
export function domainPortal(): SignerPortal {
  const portal = createSignPortal()
  const ctx = (request: Request): PortalContext => ({ env, meta: signerMeta(request), waitUntil })
  return {
    openSession: (request, input) => portal.openSession(ctx(request), input),
    verify: (request, input) => portal.verify(ctx(request), input),
    resendCode: (request, input) => portal.resendCode(ctx(request), input),
    envelope: (request, session) => portal.envelope(ctx(request), session),
    document: (request, session, documentId) => portal.document(ctx(request), session, documentId),
    consent: (request, session, input) => portal.consent(ctx(request), session, input),
    complete: (request, session, input) => portal.complete(ctx(request), session, input),
    decline: (request, session, input) => portal.decline(ctx(request), session, input),
    download: (request, session) => portal.download(ctx(request), session),
  }
}
