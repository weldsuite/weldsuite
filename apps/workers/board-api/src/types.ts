import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';
import type { BoardRoom } from './room/board-room';

/**
 * board-api bindings: the kit's (auth, tenant DB, flags) plus only what the
 * board module uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv {
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;
  /** Sent as x-internal-secret on every realtime-worker /publish/* call. */
  REALTIME_INTERNAL_SECRET?: string;
  /** One BoardRoom per board, named `${workspaceId}:${boardId}`. */
  BOARD_ROOM: DurableObjectNamespace<BoardRoom>;
  /** Board checkpoints and thumbnails (private bucket, `workspaces/<org>/boards/<id>/…`). */
  PRIVATE_STORAGE: R2Bucket;
  /** Cloudflare account and AI Gateway token, for the AI actions (@weldsuite/ai). */
  CF_ACCOUNT_ID?: string;
  AI_GATEWAY_API_TOKEN?: string;
  CLOUDFLARE_API_TOKEN?: string;
  AI_GATEWAY_ID?: string;
  AI_BYOK_PROVIDERS?: string;
  AI_FALLBACK_MODEL?: string;
}

export type Variables = KitVariables;
