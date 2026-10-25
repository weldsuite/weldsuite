// Worker types for the server half of the app. Kept by hand (the bindings are
// few) instead of `wrangler types`, whose runtime globals clash with the DOM lib
// the browser half compiles against. Keep in sync with wrangler.toml.

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

declare namespace Cloudflare {
  interface Env {
    /** desk-api, which serves /public/helpcenter/*. Absent in local dev. */
    DESK_API?: Fetcher
    /** Upstream origin when there is no DESK_API binding (local dev). */
    HELPCENTER_API_URL?: string
    /** Help center shown on hosts that name none (localhost, workers.dev). Empty = none. */
    FALLBACK_DOMAIN?: string
  }
}

declare module 'cloudflare:workers' {
  export const env: Cloudflare.Env
}

// Workers expose the zone's shared HTTP cache as `caches.default`.
interface CacheStorage {
  readonly default: Cache
}
