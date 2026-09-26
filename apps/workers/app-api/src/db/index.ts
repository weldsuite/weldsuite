/**
 * App API database client. Moved to @weldsuite/worker-kit so every API
 * worker resolves the master and tenant DBs the same way; this re-export
 * keeps the ~500 existing `../db` imports working.
 */

export {
  getMasterDb,
  getTenantDbForWorkspace,
  getWorkspaceContextForOrg,
  getWorkspaceForOrg,
  masterSchema,
  schema,
  type Database,
  type MasterDatabase,
} from '@weldsuite/worker-kit/db';
