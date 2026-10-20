import type { AuditQueueMessage } from './services/batch-processor';

export interface Env {
  DATABASE_URL_MASTER: string;
  ENVIRONMENT: string;
  WORKSPACE_CACHE: KVNamespace;
  /** The queue this worker consumes: locked events are sent back onto it with a delay. */
  AUDIT_EVENTS: Queue<AuditQueueMessage>;
  NEON_API_KEY: string;
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;
}
