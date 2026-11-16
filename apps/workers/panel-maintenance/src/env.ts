/**
 * panel-maintenance bindings. Add a binding here and in wrangler.toml together.
 *
 * Secrets (scripts/secrets/manifest.ts → "panel-maintenance"):
 * DATABASE_URL_MASTER (project registry and plans, read only), CF_ACCOUNT_ID
 * and PANEL_CATALOG_TOKEN (the R2 Data Catalog token the container job opens
 * the Iceberg tables with).
 */

import type { PanelProjectNamespace } from '@weldsuite/panel-domain/project-object';
import type { MaintenanceJob } from './container';
import type { MaintenanceLedger } from './ledger';
import type { MaintenanceParams } from './workflow';

export interface Env {
  ENVIRONMENT: 'development' | 'test' | 'production';
  DATABASE_URL_MASTER: string;
  CF_ACCOUNT_ID: string;
  /** R2 token with access to the Data Catalog of the panel bucket. Reaches the container as an environment variable. */
  PANEL_CATALOG_TOKEN: string;
  /** Basin bucket that holds the `panel.*` tables (`weldsuite-panel`, `-test` for test). */
  PANEL_BASIN_BUCKET: string;
  /** Overrides of what is derived from the account and bucket (`https://catalog.cloudflarestorage.com/<account>/<bucket>`, `<account>_<bucket>`). */
  PANEL_CATALOG_URI?: string;
  PANEL_CATALOG_WAREHOUSE?: string;
  /** Erasures waiting for the next rewrite (one instance, `idFromName('global')`). */
  MAINTENANCE_LEDGER: DurableObjectNamespace<MaintenanceLedger>;
  /** The PyIceberg container (one instance, `idFromName('job')`). */
  MAINTENANCE_JOB: DurableObjectNamespace<MaintenanceJob>;
  MAINTENANCE_WORKFLOW: Workflow<MaintenanceParams>;
  /** The PanelProject object, hosted by panel-ingest (`script_name`): `clearErased` after a rewrite. */
  PANEL_PROJECT: PanelProjectNamespace;
}
