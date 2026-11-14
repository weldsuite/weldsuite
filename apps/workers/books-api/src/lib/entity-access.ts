/**
 * Per-entity record checks for books-api (weldsuite-documentation/plans/legal-entities.md,
 * "Per-entity access").
 *
 * `legalEntityContext()` decides which entity a request is scoped to. A route
 * that loads a record by an id (path or body) must also make sure the record
 * belongs to an entity the request may touch: a member who is not uniformly
 * allowed (a restricted entity, or an entity role) may only reach records of
 * the entity the request is scoped to, and a record of another entity answers
 * 404, so its existence is never confirmed.
 *
 * `guardEntityRecords(app, table)` does that for every handler of a router
 * that takes the table's id as a path parameter, in one middleware: it looks
 * the row up and asks `recordInRequestEntity`. It costs nothing for members
 * whose access is the same everywhere (owners, `legal_entities:manage`, or no
 * restricted entity and no entity role): no query is made. `recordsInEntity`
 * is the same check for ids that arrive in a body or query.
 */

import type { Context, Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { getEntityAccess, recordInRequestEntity } from '@weldsuite/core-domain/legal-entities';
import { error } from '@weldsuite/worker-kit/response';
import type { Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../types';

/** A table whose rows belong to one entity. */
export type EntityScopedTable = PgTable & { id: PgColumn; entityId: PgColumn };

type BooksApp = Hono<{ Bindings: Env; Variables: Variables }>;

/** Whether per-record checks can be skipped for this request: no member, or access that is the same everywhere. */
async function accessIsUniform(c: Context): Promise<boolean> {
  if (!c.get('userId') || !c.get('tenantDb')) return true;
  return (await getEntityAccess(c)).uniform;
}

/**
 * Whether every record (by id) of `table` belongs to an entity the request
 * may touch. Unknown ids pass (the handler answers its own 404).
 */
export async function recordsInEntity(
  c: Context,
  table: EntityScopedTable,
  ids: ReadonlyArray<string | null | undefined>,
): Promise<boolean> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (wanted.length === 0 || (await accessIsUniform(c))) return true;
  const db = c.get('tenantDb') as Database;
  const rows = (await db
    .select({ entityId: table.entityId })
    .from(table as PgTable)
    .where(wanted.length === 1 ? eq(table.id, wanted[0]) : inArray(table.id, wanted))) as Array<{ entityId: string | null }>;
  for (const row of rows) {
    if (!(await recordInRequestEntity(c, row.entityId))) return false;
  }
  return true;
}

export interface GuardOptions {
  /** The path parameter that holds the id (default `id`). */
  param?: string;
  /** Path the parameter sits under, e.g. `/import-batches` for `/import-batches/:batchId`. */
  prefix?: string;
  /** Resource name in the 404 (default `Record`). */
  label?: string;
}

/**
 * Register, before the router's handlers, a check on every route that has
 * `:param` (`/:id` and everything under it): the row of `table` it names must
 * be in an entity the request may touch, else 404.
 */
export function guardEntityRecords(app: BooksApp, table: EntityScopedTable, options: GuardOptions = {}): void {
  const param = options.param ?? 'id';
  const prefix = options.prefix ?? '';
  const label = options.label ?? 'Record';
  const guard = async (c: Context, next: () => Promise<void>) => {
    const id = c.req.param(param);
    if (id && !(await recordsInEntity(c, table, [id]))) return error.notFound(c, label, id);
    return next();
  };
  // `/:id/*` also matches `/:id` itself.
  app.use(`${prefix}/:${param}/*`, guard);
}

/**
 * 404 helper for handlers that already loaded the row: `null` when the record
 * may be touched, else the response to return.
 *
 *   const denied = await denyForeignRecord(c, 'Invoice', id, invoice.entityId);
 *   if (denied) return denied;
 */
export async function denyForeignRecord(
  c: Context,
  label: string,
  id: string,
  recordEntityId: string | null | undefined,
): Promise<Response | null> {
  return (await recordInRequestEntity(c, recordEntityId)) ? null : error.notFound(c, label, id);
}
