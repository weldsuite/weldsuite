/**
 * Bot checks behind one small interface (ADR FORMS-005): `take()` hands out a
 * fresh token for one request. Turnstile and ALTCHA tokens are single use, so
 * after a token is taken the next one is prepared for the next request.
 *
 * - `none`: no token.
 * - Turnstile (Global): Cloudflare's script and widget, `interaction-only` so
 *   most visitors never see anything.
 * - ALTCHA (Kubernetes): proof of work solved here, no third party. The
 *   challenge comes from forms-api (`GET /public/forms/altcha/challenge`, via
 *   the portal's /api/altcha/challenge). The widget is this adapter; there is
 *   no UI, the work runs in the background after the page loads.
 */

import { formsApi, type AltchaChallenge } from '@/lib/client/api'

export interface BotAdapter {
  /** A token for one request; undefined when there is no bot check. Rejects when the check cannot run. */
  take: () => Promise<string | undefined>
  destroy: () => void
}

/** How long `take()` waits for a token before giving up. */
const TAKE_TIMEOUT_MS = 30_000

export const noBotCheck: BotAdapter = { take: () => Promise.resolve(undefined), destroy: () => undefined }

// ---------------------------------------------------------------------------
// ALTCHA
// ---------------------------------------------------------------------------

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Finds the number behind the challenge hash and answers the base64 JSON payload forms-api verifies. */
export async function solveAltcha(challenge: AltchaChallenge): Promise<string> {
  const BATCH = 400
  for (let start = 0; start <= challenge.maxnumber; start += BATCH) {
    const numbers = Array.from({ length: Math.min(BATCH, challenge.maxnumber - start + 1) }, (_, i) => start + i)
    const hashes = await Promise.all(numbers.map((n) => sha256Hex(`${challenge.salt}${n}`)))
    const at = hashes.indexOf(challenge.challenge)
    const found = at === -1 ? undefined : numbers[at]
    if (found !== undefined) {
      return btoa(
        JSON.stringify({
          algorithm: challenge.algorithm,
          challenge: challenge.challenge,
          number: found,
          salt: challenge.salt,
          signature: challenge.signature,
        }),
      )
    }
  }
  throw new Error('The proof of work has no solution')
}

/** A solved challenge is valid for 10 minutes on the server; use it within 8. */
const ALTCHA_FRESH_MS = 8 * 60 * 1000

export function createAltchaAdapter(
  fetchChallenge: () => Promise<AltchaChallenge> = () => formsApi.altchaChallenge(),
  now: () => number = Date.now,
): BotAdapter {
  let ready: { token: Promise<string>; at: number } | null = null
  const prepare = () => {
    const token = fetchChallenge().then(solveAltcha)
    // A failure surfaces in take(); nobody awaits this copy.
    token.catch(() => undefined)
    ready = { token, at: now() }
  }
  // Starts working as soon as the page is up, not at the first Next.
  prepare()
  return {
    async take() {
      if (!ready || now() - ready.at > ALTCHA_FRESH_MS) prepare()
      const current = ready
      if (!current) throw new Error('No bot check')
      ready = null
      try {
        return await current.token
      } finally {
        // The next request will want its own token: start on it now.
        prepare()
      }
    },
    destroy() {
      ready = null
    },
  }
}

// ---------------------------------------------------------------------------
// Turnstile
// ---------------------------------------------------------------------------

interface TurnstileApi {
  render: (container: HTMLElement, options: Record<string, unknown>) => string
  reset: (widgetId: string) => void
  remove: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
let turnstileScript: Promise<TurnstileApi> | null = null

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  turnstileScript ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = TURNSTILE_SRC
    script.async = true
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not load')))
    script.onerror = () => {
      turnstileScript = null
      reject(new Error('Turnstile is blocked or unreachable'))
    }
    document.head.appendChild(script)
  })
  return turnstileScript
}

export function createTurnstileAdapter(container: HTMLElement, siteKey: string): BotAdapter {
  let token: string | null = null
  let widgetId: string | null = null
  let failed: Error | null = null
  let api: TurnstileApi | null = null
  let waiters: Array<{ resolve: (token: string) => void; reject: (error: Error) => void }> = []
  let destroyed = false

  const settle = () => {
    if (token) {
      const waiter = waiters.shift()
      if (waiter) {
        const taken = token
        token = null
        waiter.resolve(taken)
        if (widgetId && api) api.reset(widgetId)
      }
    }
    if (failed) {
      const error = failed
      for (const w of waiters) w.reject(error)
      waiters = []
    }
  }

  loadTurnstile().then(
    (turnstile) => {
      if (destroyed) return
      api = turnstile
      widgetId = turnstile.render(container, {
        sitekey: siteKey,
        // Invisible unless Cloudflare needs the visitor to do something.
        appearance: 'interaction-only',
        retry: 'auto',
        callback: (value: string) => {
          token = value
          failed = null
          settle()
        },
        'expired-callback': () => {
          token = null
          if (widgetId) turnstile.reset(widgetId)
        },
        'error-callback': () => {
          failed = new Error('Turnstile failed')
          settle()
        },
      })
    },
    (error: Error) => {
      failed = error
      settle()
    },
  )

  return {
    take() {
      if (failed) return Promise.reject(failed)
      return new Promise<string>((resolve, reject) => {
        const waiter = { resolve, reject }
        waiters.push(waiter)
        const timer = setTimeout(() => {
          waiters = waiters.filter((w) => w !== waiter)
          reject(new Error('The bot check timed out'))
        }, TAKE_TIMEOUT_MS)
        const done = (fn: () => void) => () => {
          clearTimeout(timer)
          fn()
        }
        waiter.resolve = (t) => done(() => resolve(t))()
        waiter.reject = (e) => done(() => reject(e))()
        settle()
      })
    },
    destroy() {
      destroyed = true
      if (widgetId && api) api.remove(widgetId)
      for (const w of waiters) w.reject(new Error('Closed'))
      waiters = []
    },
  }
}
