import { createServerFn } from '@tanstack/react-start';
import { loadDatabasesPage } from './data';
import { globalOnly } from '@/lib/edition';

/**
 * The databases overview's data, on the server. `compute` is a `ReadonlyMap`:
 * a `Map` at runtime, which Start serializes, but its type check only accepts
 * `Map`, so the output check is off.
 */
export const getDatabasesPage = createServerFn({ method: 'GET', strict: { output: false } }).middleware([globalOnly])
  .handler(() => loadDatabasesPage());
