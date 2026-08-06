import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { AnalyticsRecord } from './analytics/transform';

/**
 * Cloudflare Pipelines binding.
 *
 * Declared here rather than imported: the pinned `@cloudflare/workers-types`
 * (4.20250110) predates the `Pipeline` global, so referencing it fails to
 * compile — which is exactly why analytics-worker's own `env.ts` has never
 * type-checked. Only `send` is used.
 */
interface PipelineBinding<T = Record<string, unknown>> {
  send(records: T[]): Promise<void>;
}

export interface Env {
  ENVIRONMENT: string;

  // Master DB + Neon, for resolving a workspace's tenant database. Only
  // consumers that set `needsTenantDb` cause these to be read.
  DATABASE_URL_MASTER: string;
  NEON_API_KEY: string;
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;
  WORKSPACE_CACHE: KVNamespace;

  /** Cloudflare Pipeline → R2 Iceberg. Used by the `analytics` consumer. */
  ANALYTICS_STREAM?: PipelineBinding<AnalyticsRecord>;

  /** WeldConnect engine (workflow-worker). Used by `workflow-triggers`. */
  EXECUTE_WORKFLOW?: {
    create: (init: { id?: string; params: Record<string, unknown> }) => Promise<unknown>;
  };

  // Downstream queues for `transport: 'queue'` consumers. The dispatcher looks
  // a binding up by name, so a consumer's queueBinding must match a field here.
  /** app-api's semantic indexer. Used by `search-index`. */
  SEARCH_EVENTS?: Queue<EntityEventMessage>;
}
