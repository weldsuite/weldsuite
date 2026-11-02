/**
 * Server-only: the signer operations the portal's routes run, from one of
 * two places, picked at run time by `SIGN_PORTAL_BACKEND`:
 *
 * - unset (Global, ADR FE-016): the domain code, `createSignPortal()`, run by
 *   this Worker against its own bindings (`runtime.ts`);
 * - `rust` (Kubernetes, ADR FE-017): the backend's `/public/sign-portal/*`
 *   endpoints over HTTP at `SIGN_PORTAL_BACKEND_URL`, with the shared
 *   `SIGN_PORTAL_SECRET` and the signer's IP from the ingress
 *   (`@weldsuite/sign-domain/portal-client`).
 *
 * Both answer with the same `Response`s, so the routes don't know which one
 * they have. Never import this from a client component.
 */

import { signPortalClientFromEnv } from '@weldsuite/sign-domain/portal-client'
import { domainPortal, runtimeEnv, signerMeta } from '@/lib/server/runtime'

/** Each operation takes the browser's request, for the signer's IP and browser. */
export interface SignerPortal {
  openSession(request: Request, input: unknown): Promise<Response>
  verify(request: Request, input: unknown): Promise<Response>
  resendCode(request: Request, input: unknown): Promise<Response>
  envelope(request: Request, session: string | undefined): Promise<Response>
  document(request: Request, session: string | undefined, documentId: string): Promise<Response>
  consent(request: Request, session: string | undefined, input: unknown): Promise<Response>
  complete(request: Request, session: string | undefined, input: unknown): Promise<Response>
  decline(request: Request, session: string | undefined, input: unknown): Promise<Response>
  download(request: Request, session: string | undefined): Promise<Response>
}

let selected: SignerPortal | undefined

/** The configured signer operations, picked on first use. */
export function signerPortal(): SignerPortal {
  selected ??= select()
  return selected
}

function select(): SignerPortal {
  const client = signPortalClientFromEnv(runtimeEnv())
  if (!client) return domainPortal()
  return {
    openSession: (request, input) => client.openSession(signerMeta(request), input),
    verify: (request, input) => client.verify(signerMeta(request), input),
    resendCode: (request, input) => client.resendCode(signerMeta(request), input),
    envelope: (request, session) => client.envelope(signerMeta(request), session),
    document: (request, session, documentId) => client.document(signerMeta(request), session, documentId),
    consent: (request, session, input) => client.consent(signerMeta(request), session, input),
    complete: (request, session, input) => client.complete(signerMeta(request), session, input),
    decline: (request, session, input) => client.decline(signerMeta(request), session, input),
    download: (request, session) => client.download(signerMeta(request), session),
  }
}
