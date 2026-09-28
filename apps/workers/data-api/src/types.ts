import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';

/**
 * data-api bindings: the kit's (auth, tenant DB, flags) plus only what
 * the data module uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv {
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;

  /** CF Workflow that runs a WeldData enrichment column across leads in the
   *  background. Hosted in this worker (class re-exported from src/index.ts)
   *  under the `welddata-enrich-v2*` names — app-api's old `welddata-enrich*`
   *  names keep draining (docs/plans/app-api-module-split.md). */
  WELDDATA_ENRICH?: Workflow<{
    workspaceId: string;
    userId: string;
    listId: string;
    columnId: string;
    leadIds: string[];
  }>;

  /** Lemlist API key — WeldData lead database. Shared WeldSuite key, set via
   *  `wrangler secret put LEMLIST_API_KEY`. Optional locally. */
  LEMLIST_API_KEY?: string;
  /** Findymail API key — WeldData email-finder enrichment action. Set via
   *  `wrangler secret put FINDYMAIL_API_KEY`. Optional locally. */
  FINDYMAIL_API_KEY?: string;
  /** Prospeo API key — WeldData email-finder enrichment action. Set via
   *  `wrangler secret put PROSPEO_API_KEY`. Optional locally. */
  PROSPEO_API_KEY?: string;
}

export type Variables = KitVariables;
