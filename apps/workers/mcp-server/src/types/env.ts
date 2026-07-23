import type { RateLimiter } from '../durable-objects/rate-limiter';

/**
 * Cloudflare Workers environment bindings for MCP server
 */
export interface Env {
  // Neon connection string for master DB (set via wrangler secret)
  DATABASE_URL_MASTER: string;

  // KV namespace for caching API key registry lookups and workspace details
  // Shared with external-api for cache coherence
  API_CACHE: KVNamespace;

  // Durable Objects for distributed per-workspace rate limiting
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;

  // Environment
  ENVIRONMENT: 'test' | 'preview' | 'production';

  // Base URL of the external API the MCP tools proxy to (e.g.
  // https://api.weldsuite.org). Used only to construct the request URL's
  // path/query — set per-environment in wrangler.toml.
  EXTERNAL_API_BASE_URL: string;

  // Service binding to the External API worker (weldsuite-external-api).
  // Tool calls are proxied over this binding instead of the public hostname so
  // the subrequest bypasses the Cloudflare edge — same-zone Worker→Worker calls
  // over a public hostname die at the edge with HTTP 530. Configured per
  // environment in wrangler.toml ([[services]] / [[env.<env>.services]]).
  EXTERNAL_API: Fetcher;

  // Secrets (set via wrangler secret put)
  NEON_API_KEY: string;
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;
}
