export interface Env {
  ENVIRONMENT: string;

  // Master DB + Neon, for resolving a workspace's tenant database. Only
  // consumers that set `needsTenantDb` cause these to be read.
  DATABASE_URL_MASTER: string;
  NEON_API_KEY: string;
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;
  WORKSPACE_CACHE: KVNamespace;

  // Downstream queues for `transport: 'queue'` consumers are declared here as
  // each one is migrated — e.g. `SEARCH_EVENTS?: Queue<EntityEventMessage>`.
  // The registry is empty today, so there are none. The dispatcher looks a
  // binding up by name, so a consumer's queueBinding must match a field here.
}
