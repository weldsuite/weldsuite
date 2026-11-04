import { env } from 'cloudflare:workers'
import {
  createProjectPortalApi,
  type ProjectPortalApi,
} from '@weldsuite/app-api-client/domains/project-portal'
import type { ClientApi } from '@weldsuite/app-api-client/types'

/**
 * Server-only access to flow-api's client portal API (`/public/project-portal/*`).
 * The portal never opens a database: it only calls these public routes, with
 * the contact's session token as a bearer (the token is held in an httpOnly
 * cookie, see session.ts).
 *
 * Deployed, requests go over the FLOW_API service binding (the host below is
 * never resolved). Locally there is no binding, so they go to FLOW_API_URL:
 * flow-api from `pnpm --filter flow-api dev`, on port 8804 by default.
 *
 * `createClientApi` always uses the global `fetch`, which cannot reach a
 * service binding, so this is a small `ClientApi` over a fetch that can.
 */
const BINDING_ORIGIN = 'https://flow-api.internal'
const DEFAULT_URL = 'http://localhost:8804'
const API_PREFIX = '/public/project-portal'

/** flow-api answered with an error status (or could not be reached: 503, `UNAVAILABLE`). */
export class PortalApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'PortalApiError'
  }
}

interface ErrorBody {
  error?: { code?: unknown; message?: unknown }
}

function origin(): string {
  return env.FLOW_API ? BINDING_ORIGIN : env.FLOW_API_URL || DEFAULT_URL
}

function send(url: string, init: RequestInit): Promise<Response> {
  return env.FLOW_API ? env.FLOW_API.fetch(url, init) : fetch(url, init)
}

async function failure(res: Response): Promise<PortalApiError> {
  const body = (await res.json().catch(() => null)) as ErrorBody | null
  const code = typeof body?.error?.code === 'string' ? body.error.code : 'UPSTREAM_ERROR'
  const message = typeof body?.error?.message === 'string' ? body.error.message : `flow-api answered ${res.status}`
  return new PortalApiError(res.status, code, message)
}

function clientApi(token: string | undefined): ClientApi {
  async function request(method: string, path: string, body?: BodyInit, json = true): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    if (body !== undefined && json) headers['Content-Type'] = 'application/json'
    try {
      return await send(`${origin()}${API_PREFIX}${path}`, { method, headers, body })
    } catch (err) {
      console.error('[project-portal] flow-api unreachable:', err)
      throw new PortalApiError(503, 'UNAVAILABLE', 'flow-api unreachable')
    }
  }

  async function parse<T>(res: Response): Promise<T> {
    if (!res.ok) throw await failure(res)
    if (res.status === 204) return {} as T
    return (await res.json()) as T
  }

  const jsonBody = (data: unknown): string | undefined => (data ? JSON.stringify(data) : undefined)

  return {
    async get<T>(path: string): Promise<T> {
      return parse<T>(await request('GET', path))
    },
    async getRaw(path: string): Promise<Response> {
      const res = await request('GET', path)
      if (!res.ok) throw await failure(res)
      return res
    },
    async post<T>(path: string, data?: unknown): Promise<T> {
      return parse<T>(await request('POST', path, jsonBody(data)))
    },
    async put<T>(path: string, data?: unknown): Promise<T> {
      return parse<T>(await request('PUT', path, jsonBody(data)))
    },
    async patch<T>(path: string, data?: unknown): Promise<T> {
      return parse<T>(await request('PATCH', path, jsonBody(data)))
    },
    async delete<T>(path: string): Promise<T> {
      return parse<T>(await request('DELETE', path))
    },
    async postForm<T>(path: string, form: FormData): Promise<T> {
      return parse<T>(await request('POST', path, form, false))
    },
  }
}

/** The portal API for one contact's session token (none: the sign-in calls). */
export function portalApi(token?: string): ProjectPortalApi {
  return createProjectPortalApi(clientApi(token))
}
