/**
 * panel-ingest bindings. Phase 0 has none beyond the environment name; the
 * project registry KV, the Basin stream, the replay bucket and the
 * PanelProject / PanelUsage Durable Objects arrive with phase 1 and 4
 * (docs/plans/weldpanel.md). Add a binding here and in wrangler.toml together.
 */
export interface Env {
  ENVIRONMENT: 'development' | 'test' | 'production';
}
