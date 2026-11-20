// Worker types for the server half of the app. Kept by hand (the bindings are
// few) instead of `wrangler types`, whose runtime globals clash with the DOM lib
// the browser half compiles against. Keep in sync with wrangler.toml.

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

declare namespace Cloudflare {
  interface Env {
    /** forms-api, which serves /public/forms/*. Absent in local dev. */
    FORMS_API?: Fetcher
    /** forms-api's origin when there is no FORMS_API binding (local dev). */
    FORMS_API_URL?: string
    /** The shared key sent as X-Forms-Portal-Key (secret). */
    FORMS_PORTAL_SECRET?: string
    /** `development`, `test` or `production`. */
    ENVIRONMENT?: string
  }
}

declare module 'cloudflare:workers' {
  export const env: Cloudflare.Env
}

/** The embed SDK (packages/sdk/forms-embed) as one script, built by vite-plugins/forms-embed.ts. */
declare module 'virtual:forms-embed' {
  const source: string
  export default source
}
