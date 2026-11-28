/**
 * Server-only: the signer operations the portal's routes run: the Rust
 * backend's `/public/sign-portal/*` endpoints over HTTP at
 * `SIGN_PORTAL_BACKEND_URL`, with the shared `SIGN_PORTAL_SECRET` and the
 * signer's IP from the ingress (`./portal-client.ts`, ADR FE-017). Never
 * import this from a client component.
 */

import { signPortalClientFromEnv } from '@/lib/server/portal-client'
import { runtimeEnv, signerMeta } from '@/lib/server/runtime'

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

/** The advanced and qualified signature operations (eIDAS). */
export interface EidasSignerPortal {
  signatureStart(request: Request, session: string | undefined, input: unknown): Promise<Response>
  signatureFinish(request: Request, session: string | undefined, input: unknown): Promise<Response>
  signatureCancel(request: Request, session: string | undefined, input: unknown): Promise<Response>
  evidence(request: Request, session: string | undefined): Promise<Response>
}

export type FullSignerPortal = SignerPortal & EidasSignerPortal

let selected: FullSignerPortal | undefined

/** The configured signer operations, picked on first use. */
export function signerPortal(): FullSignerPortal {
  selected ??= select()
  return selected
}

function select(): FullSignerPortal {
  const client = signPortalClientFromEnv(runtimeEnv())
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
    signatureStart: (request, session, input) => client.signatureStart(signerMeta(request), session, input),
    signatureFinish: (request, session, input) => client.signatureFinish(signerMeta(request), session, input),
    signatureCancel: (request, session, input) => client.signatureCancel(signerMeta(request), session, input),
    evidence: (request, session) => client.evidence(signerMeta(request), session),
  }
}
