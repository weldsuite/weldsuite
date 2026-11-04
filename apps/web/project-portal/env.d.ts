// Worker types for the server half of the app. Kept by hand (the bindings are
// few) instead of `wrangler types`, whose runtime globals clash with the DOM lib
// the browser half compiles against. Keep in sync with wrangler.toml.

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

declare namespace Cloudflare {
  interface Env {
    /** flow-api, which serves /public/project-portal/*. Absent in local dev. */
    FLOW_API?: Fetcher
    /** flow-api's origin when there is no FLOW_API binding (local dev). */
    FLOW_API_URL?: string
    /** `development`, `test` or `production`. */
    ENVIRONMENT?: string
  }
}

declare module 'cloudflare:workers' {
  export const env: Cloudflare.Env
}
