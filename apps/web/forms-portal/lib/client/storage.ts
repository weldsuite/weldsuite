/**
 * What the page keeps in the browser. No cookies: in an embed on someone
 * else's site third-party cookies are blocked, while iframe storage is
 * partitioned and still works (weldsuite-documentation/plans/weldforms.md, "Respondent sessions").
 *
 * - `localStorage`, per form: the session token (resume within its 7 days) and
 *   a random browser key for the soft one-response-per-browser limit.
 * - `sessionStorage`, per form: the view key, so a reload is not a second view.
 *
 * Storage can be blocked or full; everything falls back to memory.
 */

export interface StoredSession {
  session: string
  responseId: string
  /** ISO time the token stops working. */
  expiresAt: string
}

const memory = new Map<string, string>()

function read(kind: 'local' | 'session', key: string): string | null {
  try {
    const store = kind === 'local' ? window.localStorage : window.sessionStorage
    return store.getItem(key) ?? memory.get(`${kind}:${key}`) ?? null
  } catch {
    return memory.get(`${kind}:${key}`) ?? null
  }
}

function write(kind: 'local' | 'session', key: string, value: string): void {
  memory.set(`${kind}:${key}`, value)
  try {
    const store = kind === 'local' ? window.localStorage : window.sessionStorage
    store.setItem(key, value)
  } catch {
    // Kept in memory for this page only.
  }
}

function remove(kind: 'local' | 'session', key: string): void {
  memory.delete(`${kind}:${key}`)
  try {
    const store = kind === 'local' ? window.localStorage : window.sessionStorage
    store.removeItem(key)
  } catch {
    // Nothing to remove.
  }
}

function randomId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function loadStoredSession(publicId: string, now = Date.now()): StoredSession | null {
  const raw = read('local', `wf:session:${publicId}`)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSession>
    if (typeof parsed.session !== 'string' || typeof parsed.responseId !== 'string' || typeof parsed.expiresAt !== 'string') return null
    if (Date.parse(parsed.expiresAt) <= now) {
      clearStoredSession(publicId)
      return null
    }
    return { session: parsed.session, responseId: parsed.responseId, expiresAt: parsed.expiresAt }
  } catch {
    return null
  }
}

export function saveStoredSession(publicId: string, value: StoredSession): void {
  write('local', `wf:session:${publicId}`, JSON.stringify(value))
}

export function clearStoredSession(publicId: string): void {
  remove('local', `wf:session:${publicId}`)
}

/** A random id this browser keeps per form (the soft one-per-browser limit). */
export function browserKey(publicId: string): string {
  const key = `wf:browser:${publicId}`
  const existing = read('local', key)
  if (existing) return existing
  const created = randomId()
  write('local', key, created)
  return created
}

/** A random id per browser tab and form; true as the second element when it was just made (the view is new). */
export function viewKey(publicId: string): { key: string; fresh: boolean } {
  const storageKey = `wf:view:${publicId}`
  const existing = read('session', storageKey)
  if (existing) return { key: existing, fresh: false }
  const created = randomId()
  write('session', storageKey, created)
  return { key: created, fresh: true }
}
