/**
 * Entity-linked chat channels (app-api).
 *
 * Importing this module registers all known entity providers so that
 * `getEntityProvider(type)` returns the right one at runtime. New entity
 * types are added by creating a file under `./providers` that calls
 * `registerEntityProvider(...)` at import time, and adding an import here.
 */
import './providers/task';
import './providers/project';
import './providers/contact';

export * from './registry';
export * from './get-or-create-channel';
