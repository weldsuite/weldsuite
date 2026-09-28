import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';

/**
 * social-api bindings: the kit's (auth, tenant DB, flags) plus only what
 * the social module uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv {
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;

  // --- WeldSocial (PostPeer unified social publishing) -------------------
  /** PostPeer API key (single WeldSuite-level key, sent as `x-access-key`).
   *  Set via `wrangler secret put POSTPEER_API_KEY`. Optional locally — when
   *  unset, provider actions return a configuration error and CRUD still works. */
  POSTPEER_API_KEY?: string;
  /** Override the PostPeer REST base URL. Defaults to https://api.postpeer.dev/v1. */
  POSTPEER_BASE_URL?: string;
  /** Shared secret used to verify PostPeer webhook signatures. */
  POSTPEER_WEBHOOK_SECRET?: string;
  /**
   * BYOK OAuth apps, as a JSON object of platform → PostPeer app id, e.g.
   * `{"twitter":"app_123","linkedin":"app_456"}`. Apps are per-platform and are
   * registered on PostPeer via /v1/apps. Platforms absent from the map (and an
   * unset value) connect under PostPeer's own system app, so the consent screen
   * shows PostPeer's branding rather than WeldSuite's.
   */
  POSTPEER_APP_IDS?: string;
}

export type Variables = KitVariables;
