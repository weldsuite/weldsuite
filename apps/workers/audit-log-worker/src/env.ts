export interface Env {
  DATABASE_URL_MASTER: string;
  ENVIRONMENT: string;
  WORKSPACE_CACHE: KVNamespace;
  NEON_API_KEY: string;
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;
}
