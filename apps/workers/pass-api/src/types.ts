import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';

/**
 * pass-api bindings: the kit's (auth, tenant DB, flags) plus only what
 * WeldPass uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv {
  /** Entity-events hub queue (publishEntityEvent). WeldPass publishes none —
   *  it keeps its own weldpass_audit_events trail — but the binding is part of
   *  every API worker's baseline. */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;
  /**
   * 32-byte hex. Wraps every vault's key-encryption key; the vault contents
   * are unreadable without it. NOT the same as DATABASE_ENCRYPTION_KEY, which
   * only protects stored tenant DB URLs. Losing this makes every stored secret
   * unrecoverable — keep a backup outside this worker.
   */
  WELDPASS_ROOT_KEY?: string;
  /** Present only while a WeldPass root-key rotation is in flight. */
  WELDPASS_ROOT_KEY_V2?: string;
}

export type Variables = KitVariables;
