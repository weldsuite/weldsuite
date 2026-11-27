/**
 * The calls to the WeldSuite server's `/public/weldbooks/documents/{token}`
 * routes (see lib/contract.ts). They run on the server only. The token is the
 * customer's only credential: it goes into the backend's path and nowhere
 * else, and neither it nor the URL is ever logged.
 */

import type { z } from 'zod'
import {
  acceptResponseSchema,
  documentResponseSchema,
  isPlausibleToken,
  payResponseSchema,
  type AcceptInput,
  type AcceptResult,
  type FailureReason,
  type PublicDocument,
  type Result,
} from '../contract'
import { backendBaseUrl } from './config'

const TIMEOUT_MS = 15_000

function failure(reason: FailureReason): { ok: false; reason: FailureReason } {
  return { ok: false, reason }
}

/** What an HTTP status means for the page. */
export function reasonForStatus(status: number): FailureReason {
  if (status === 404 || status === 410) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 429) return 'rate_limited'
  if (status === 503) return 'unavailable'
  if (status === 400 || status === 422) return 'invalid'
  return 'network'
}

function documentUrl(token: string, suffix = ''): string | null {
  const base = backendBaseUrl()
  if (!base || !isPlausibleToken(token)) return null
  return `${base}/public/weldbooks/documents/${encodeURIComponent(token)}${suffix}`
}

async function call(url: string, init: RequestInit = {}): Promise<Response | null> {
  try {
    return await fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'application/json', ...init.headers },
    })
  } catch {
    return null
  }
}

async function callJson<S extends z.ZodTypeAny>(url: string, schema: S, init?: RequestInit): Promise<Result<z.infer<S>['data']>> {
  const response = await call(url, init)
  if (!response) return failure('network')
  if (!response.ok) return failure(reasonForStatus(response.status))
  const parsed = schema.safeParse(await response.json().catch(() => null))
  // An answer that does not match the contract is the portal's problem, not the customer's.
  return parsed.success ? { ok: true, data: parsed.data.data } : failure('network')
}

/** A token that cannot be one is as unknown as a revoked one, and costs no call. */
const unknownToken = failure('not_found')

export async function getDocument(token: string): Promise<Result<PublicDocument>> {
  const url = documentUrl(token)
  return url ? callJson(url, documentResponseSchema) : unknownToken
}

export async function createPayment(token: string, returnUrl: string): Promise<Result<{ checkoutUrl: string }>> {
  const url = documentUrl(token, '/pay')
  if (!url) return unknownToken
  return callJson(url, payResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnUrl }),
  })
}

export async function acceptQuote(token: string, input: AcceptInput): Promise<Result<AcceptResult>> {
  const url = documentUrl(token, '/accept')
  if (!url) return unknownToken
  return callJson(url, acceptResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

/** The PDF, passed through as a stream, or a failure. */
export async function getPdf(token: string): Promise<{ ok: true; response: Response } | { ok: false; reason: FailureReason }> {
  const url = documentUrl(token, '/pdf')
  if (!url) return unknownToken
  const response = await call(url, { headers: { Accept: 'application/pdf' } })
  if (!response) return failure('network')
  if (!response.ok) return failure(reasonForStatus(response.status))
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/pdf')) return failure('network')
  return { ok: true, response }
}
