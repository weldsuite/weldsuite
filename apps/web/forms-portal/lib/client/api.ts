/**
 * The browser's calls to the portal's own `/api/*` routes, which forward them
 * to forms-api (lib/server/proxy.ts). Responses are forms-api's:
 * `{ data }` on success, `{ error: { code, message, details? } }` on failure.
 * Types come from the shared contract (`import type`: no schema code ships).
 */

import type {
  RecordViewInput,
  ReportAbuseInput,
  SaveProgressInput,
  SendCodeInput,
  SendCodeResult,
  StartSessionInput,
  StartSessionResult,
  SubmitSessionInput,
  SubmitSessionResult,
  PublicForm,
  VerifyCodeInput,
  VerifyCodeResult,
} from '@weldsuite/app-api-client/schemas/weldforms'
import type { FileAnswerItem } from '@weldsuite/forms-engine'

/** A failed call. `status` 0 means the request never got an answer (offline). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

interface ErrorBody {
  error?: { code?: unknown; message?: unknown; details?: unknown }
}

function toError(status: number, body: ErrorBody | null): ApiError {
  const code = typeof body?.error?.code === 'string' ? body.error.code : 'UPSTREAM_ERROR'
  const message = typeof body?.error?.message === 'string' ? body.error.message : `Request failed (${status})`
  const details = typeof body?.error?.details === 'object' && body.error.details !== null ? (body.error.details as Record<string, unknown>) : undefined
  return new ApiError(status, code, message, details)
}

async function request<T>(method: string, path: string, options: { body?: unknown; session?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (options.session) headers.Authorization = `Bearer ${options.session}`
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
    })
  } catch {
    throw new ApiError(0, 'NETWORK', 'Network error')
  }
  const json = (await res.json().catch(() => null)) as ({ data?: T } & ErrorBody) | null
  if (!res.ok) throw toError(res.status, json)
  return json?.data as T
}

const enc = encodeURIComponent

export interface AltchaChallenge {
  algorithm: 'SHA-256'
  challenge: string
  salt: string
  signature: string
  maxnumber: number
}

export const formsApi = {
  form: (publicId: string, versionId: string) => request<PublicForm>('GET', `/f/${enc(publicId)}?versionId=${enc(versionId)}`),
  recordView: (publicId: string, input: RecordViewInput) => request<{ counted: boolean }>('POST', `/f/${enc(publicId)}/view`, { body: input }),
  startSession: (publicId: string, input: StartSessionInput) => request<StartSessionResult>('POST', `/f/${enc(publicId)}/sessions`, { body: input }),
  sendCode: (publicId: string, input: SendCodeInput) => request<SendCodeResult>('POST', `/f/${enc(publicId)}/send-code`, { body: input }),
  verifyCode: (publicId: string, input: VerifyCodeInput) => request<VerifyCodeResult>('POST', `/f/${enc(publicId)}/verify`, { body: input }),
  report: (publicId: string, input: ReportAbuseInput) => request<{ received: boolean }>('POST', `/f/${enc(publicId)}/report`, { body: input }),
  saveProgress: (session: string, input: SaveProgressInput) => request<{ saved: boolean }>('PUT', '/sessions/progress', { body: input, session }),
  submit: (session: string, input: SubmitSessionInput) => request<SubmitSessionResult>('POST', '/sessions/submit', { body: input, session }),
  /** The ALTCHA challenge is not wrapped in `{ data }`. */
  async altchaChallenge(): Promise<AltchaChallenge> {
    let res: Response
    try {
      res = await fetch('/api/altcha/challenge', { cache: 'no-store' })
    } catch {
      throw new ApiError(0, 'NETWORK', 'Network error')
    }
    const json = (await res.json().catch(() => null)) as (AltchaChallenge & ErrorBody) | null
    if (!res.ok || !json || typeof json.challenge !== 'string') throw toError(res.status, json)
    return json
  },
}

/** A file or signature for one field, with upload progress (fetch cannot report it). */
export function uploadFile(session: string, fieldId: string, file: File, onProgress?: (fraction: number) => void): Promise<FileAnswerItem> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/sessions/uploads')
    xhr.setRequestHeader('Authorization', `Bearer ${session}`)
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total)
    }
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'Network error'))
    xhr.onload = () => {
      type Body = ({ data?: { file?: FileAnswerItem } } & ErrorBody) | null
      const json = ((): Body => {
        try {
          return JSON.parse(xhr.responseText) as Body
        } catch {
          return null
        }
      })()
      const item = json?.data?.file
      if (xhr.status >= 200 && xhr.status < 300 && item) resolve(item)
      else reject(toError(xhr.status, json))
    }
    const form = new FormData()
    form.append('blockId', fieldId)
    form.append('file', file)
    xhr.send(form)
  })
}
