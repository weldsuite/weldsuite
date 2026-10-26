/**
 * Browser-side calls to this app's own `/api/*` server routes. The signer
 * session lives in an httpOnly cookie, so nothing here ever sees it.
 */

export class PortalApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: Record<string, unknown> | null;

  constructor(status: number, code: string | null, message: string, details: Record<string, unknown> | null) {
    super(message);
    this.name = 'PortalApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** The request never got an answer (offline, DNS, server down). */
export class PortalNetworkError extends Error {
  constructor() {
    super('Network error');
    this.name = 'PortalNetworkError';
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

let signingLink: string | null = null;

/** The link this page was opened with; sent with every call so the server picks that link's session. */
export function setSigningLink(token: string): void {
  signingLink = token;
}

async function send(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  if (signingLink) headers.set('x-sign-link', signingLink);
  try {
    return await fetch(path, { ...init, headers, credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new PortalNetworkError();
  }
}

async function failure(res: Response): Promise<PortalApiError> {
  const body = (await res.json().catch(() => ({}))) as ErrorBody;
  return new PortalApiError(res.status, body.error?.code ?? null, body.error?.message ?? res.statusText, body.error?.details ?? null);
}

/** POST/GET JSON and unwrap `{ data }`. */
export async function portalJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await send(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res);
  const json = (await res.json()) as { data: T };
  return json.data;
}

/** GET raw bytes (document PDFs). */
export async function portalBytes(path: string): Promise<ArrayBuffer> {
  const res = await send(path, { method: 'GET' });
  if (!res.ok) throw await failure(res);
  return res.arrayBuffer();
}
